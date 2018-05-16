/** @module test/features/support/stores
 *
 * Helpers for interacting with the database models.
 */

/* Test libraries */
import sinon from 'sinon';
import * as utils from '../../../utils';

/* Libraries that create the objects */
import models from '../../../../server/models';
import * as expenses from '../../../../server/graphql/mutations/expenses';
import * as libpayments from '../../../../server/lib/payments';

/** Randomize email since it's a unique key in the database
 *
 * @param {String} email An email address to be randomized.
 * @return {String} the email with a random string attached to it
 *  without making it an invalid address.
 * @example
 * > randEmail('foo@bar.com')
 * 'foo-lh1r2qglj3a@bar.com'
 * > randEmail('foo@bar.com')
 * 'foo-lwfi9uaq9ua@bar.com'
 */
export function randEmail(email) {
  const [user, domain] = email.replace(/\s/g, '-').split('@');
  const rand = Math.random().toString(36).substring(2, 15);
  return `${user}-${rand}@${domain}`;
}

/** Convert string to lower case and swap spaces with dashes */
function slugify(value) {
  return value.toLowerCase().replace(/\s/g, '-');
}

/** Create a new user with a collective
 *
 * @param {String} name is the name of the new user. The email created
 *  for the user will be `{name}@oc.com`.
 * @param {Object} data is whatever other data that needs to be passed
 *  to the user's creation. The fields "name", "email", "username" and
 *  "description" can't be overrided.
 * @return {Object} with references for `user` and `userCollective`.
 */
export async function newUser(name, data={}) {
  const slug = slugify(name);
  const email = randEmail(`${slug}@oc.com`);
  const user = await models.User.createUserWithCollective({
    ...data,
    email,
    slug,
    name,
    username: name,
    description: `A user called ${name}`,
  });
  return { user, userCollective: user.collective };
}

/**
 * Create a new host and its admin user
 *
 * @param {String} name Name of the host collective
 * @param {String} currency is the currency of the host
 * @param {String} hostFee is the per transaction Host fee
 * @returns {Object} with references for `hostCollective`,
 *  `hostAdmin`.
 */
export async function newHost(name, currency, hostFee) {
  // Host Admin
  const slug = slugify(name);
  const hostAdmin = (await newUser(`${name} Admin`)).user;
  const hostFeePercent = hostFee ? parseInt(hostFee) : 0;
  const hostCollective = await models.Collective.create({
    name, slug, currency, hostFeePercent, CreatedByUserId: hostAdmin.id,
  });
  await hostCollective.addUserWithRole(hostAdmin, 'ADMIN');
  return { hostAdmin, hostCollective };
}

/** Create new a host, a collective and add collective to the host
 *
 * @param {String} name Name of the collective.
 * @param {String} currency is the currency of the collective
 * @param {String} hostCurrency is the currency of the host
 * @param {String} hostFee is the per transaction Host fee
 * @returns {Object} with references for `hostCollective`,
 *  `hostAdmin`, and `collective`.
 */
export async function newCollectiveWithHost(name, currency, hostCurrency, hostFee) {
  const { hostAdmin, hostCollective } = await newHost(`${name} Host`, hostCurrency, hostFee);
  const slug = slugify(name);
  const { hostFeePercent } = hostCollective;
  const collective = await models.Collective.create({ name, slug, currency, hostFeePercent });
  await collective.addHost(hostCollective);
  return { hostCollective, hostAdmin, collective };
}

/** Create a collective and associate to an existing host.
 *
 * @param {String} name is the name of the collective being created.
 * @param {models.Collective} hostCollective is an already collective
 *  meant to be the host of the collective being created here.
 * @return {models.Collective} a newly created collective hosted by
 *  `hostCollective`.
 */
export async function newCollectiveInHost(name, currency, hostCollective) {
  const slug = slugify(name);
  const { hostFeePercent } = hostCollective;
  const collective = await models.Collective.create({ name, slug, currency, hostFeePercent });
  await collective.addHost(hostCollective);
  return { collective };
}

/** Create a new expense in a collective
 *
 * This is just adds an existing utility to this namespace for
 * consistency.
 * @see {graphql.mutations.expenses.createExpense}.
 *
 * This function uses the `createExpense` mutation to do its
 * job. Which guarantees that expenses created in tests will go
 * through all the same validations as if they were created by users.
 *
 * @param {models.User} user an instance of the User model that will
 *  be used to perform the action of creating the expense.
 * @param {Object} expenseData contains values for the brand new
 *  expense. It especifically waits for the fields `amount`,
 *  `currency`, `description` and `paymentMethod`.
 * @return {models.Expense} newly created expense instance.
 */
export async function createExpense(user, expenseData) {
  return expenses.createExpense(user, expenseData);
}

/** Create order and set payment method information
 *
 * @param {models.Collective} opt.from is the collective the order is
 *  initiated by.
 * @param {models.Collective} opt.to is the collective receiving the
 *  donation.
 * @param {Number} opt.amount is the amount of the order.
 * @param {String} opt.currency is the currency of the collective
 *  initiating the order.
 */
export async function newOrder(opt) {
  const { from, to, amount, currency } = opt;
  const order = await models.Order.create({
    ...opt,
    description: `Donation to ${to.slug}`,
    totalAmount: amount,
    currency,
    CreatedByUserId: from.CreatedByUserId,
    FromCollectiveId: from.id,
    CollectiveId: to.id,
  });
  await order.setPaymentMethod({
    token: 'tok_123456781234567812345678',
  });
  return { order };
}

/* -- STRIPE METHODS -- */

/** Create a stripe account for a host collective
 *
 * @param {Number} hostId is the id of the host collective that the
 *  newly created connected account object will be associated to.
 * @return {models.ConnectedAccount} the newly created connected
 *  account instance.
 */
export async function stripeConnectedAccount(hostId) {
  return models.ConnectedAccount.create({
    service: 'stripe',
    token: 'sk_test_XOFJ9lGbErcK5akcfdYM1D7j',
    username: 'acct_198T7jD8MNtzsDcg',
    CollectiveId: hostId,
  });
}

/** Create a one time donation.
 *
 * This function creates an order for a one time donation.
 *
 * @param {models.Order} opt.order is the order to be executed
 * @param {models.Collective} opt.userCollective is the collective
 *  making the donation.
 * @param {models.Collective} opt.collective is the collective
 *  receiving the donation.
 * @param {Number} opt.amount is the amount of the order in cents.
 * @param {String} opt.currency is the currency of the user making the
 *  order.
 * @param {Number} opt.appFee is the application fee to be subtracted
 *  from the order's total amount. It must be the absolute
 *  value. Not a percentage.
 * @param {Number} opt.ppFee is the payment processor fee to be
 *  subtracted from the order's total amount. It must be the absolute
 *  value. Not a percentage.
 */
export async function stripeOneTimeDonation(opt) {
  const { userCollective, collective, amount, currency, appFee, ppFee } = opt;
  const params = { from: userCollective, to: collective, amount, currency };
  const { order } = await newOrder(params)
  const user = await models.User.findById(userCollective.CreatedByUserId);
  // Every transaction made can use different values, so we stub the
  // stripe call, create the order, and restore the stripe call so it
  // can be stubbed again by the next call to this helper.
  const sandbox = sinon.sandbox.create();
  try {
    utils.stubStripeCreate(sandbox);
    utils.stubStripeBalance(sandbox, amount, currency, appFee, ppFee);
    // Although it's supposed to be OK to omit `await' when returning
    // a promise, it's causing this next call to fail so I'm keeping
    // it here.
    return await libpayments.executeOrder(user, order);
  } finally {
    sandbox.restore();
  }
}
