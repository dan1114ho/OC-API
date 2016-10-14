import Promise from 'bluebird';
import roles from '../constants/roles';
import _ from 'lodash';
import config from 'config';
import async from 'async';
import * as users from '../controllers/users';
import * as paypal from '../gateways/paypal';
import activities from '../constants/activities';
import models from '../models';
import errors from '../lib/errors';
import {getLinkHeader, getRequestedUrl, capitalize} from '../lib/utils';

/**
 * Get donations
 */
export const list = (req, res, next) => {

  const query = Object.assign({
    where: { GroupId: req.group.id },
    order: [[req.sorting.key, req.sorting.dir]]
  }, req.pagination);

  return models.Donation.findAndCountAll(query)
    .then(donations => {
      // Set headers for pagination.
      req.pagination.total = donations.count;
      res.set({ Link: getLinkHeader(getRequestedUrl(req), req.pagination) });
      res.send(_.pluck(donations.rows, 'info'));
    })
    .catch(next);
};

const getOrCreateUser = (attributes, cb) => {
   return models.User.findOne({
      where: {
        email: attributes.email
      }
    })
    .then(user => user || users._create(attributes))
    .then(user => cb(null, user))
    .catch(cb);
};

const stripeDonation = (req, res, next) => {

  const { payment } = req.required;
  const { user } = req;
  const { group } = req;
  const { interval } = payment;

  const amountFloat = payment.amount; // TODO: clean this up when we switch all amounts to INTEGER
  const amountInt = parseInt(amountFloat * 100, 10); // TODO: clean this up when we switch all amounts to INTEGER
  const currency = payment.currency || group.currency;
  const isSubscription = _.contains(['month', 'year'], interval);
  const hasFullAccount = false; // Used to specify if a user has a real account

  if (interval && !isSubscription) {
    return next(new errors.BadRequest('Interval should be month or year.'));
  }

  if (!payment.stripeToken) {
    return next(new errors.BadRequest('Stripe Token missing.'));
  }

  if (!amountFloat) {
    return next(new errors.BadRequest('Payment Amount missing.'));
  }

  if (amountInt < 50) {
    return next(new errors.BadRequest('Payment amount must be at least $0.50'));
  }

  let paymentMethod;
  let title = `Donation to ${group.name}`;

  // fetch Stripe Account and get or create Payment Method
  return Promise.props({
    stripeAccount: req.group.getStripeAccount(),
    paymentMethod: models.PaymentMethod.getOrCreate({
      token: payment.stripeToken,
      service: 'stripe',
      UserId: user.id })
    })
  .then(results => {
    const stripeAccount = results.stripeAccount;
    if (!stripeAccount || !stripeAccount.accessToken) {
      return Promise.reject(new errors.BadRequest(`The host for the collective slug ${req.group.slug} has no Stripe account set up`));
    } else if (process.env.NODE_ENV !== 'production' && _.contains(stripeAccount.accessToken, 'live')) {
      return Promise.reject(new errors.BadRequest(`You can't use a Stripe live key on ${process.env.NODE_ENV}`));
    } else {
      paymentMethod = results.paymentMethod;
      return Promise.resolve();
    }
  })
  // create a new subscription
  // (this needs to happen first, because of hook on Donation model)
  .then(() => {
    if (isSubscription) {
      title = capitalize(`${interval}ly donation to ${group.name}`);
      return models.Subscription.create({
        amount: amountFloat,
        currency,
        interval
      })
    } else {
      return Promise.resolve();
    }
  })
  // create a new donation
  .then(subscription => models.Donation.create({
      UserId: user.id,
      GroupId: group.id,
      currency: currency,
      amount: amountInt,
      title,
      PaymentMethodId: paymentMethod.id,
      SubscriptionId: subscription && subscription.id
    }))
  .then(() => res.send({success: true, user: req.user.info, hasFullAccount: hasFullAccount}))
  .catch(next);
};
export {stripeDonation as stripe};
// leaving for legacy. Delete after frontend updates
export {stripeDonation as post};

const paypalDonation = (req, res, next) => {
  const { group } = req;
  const { payment } = req.required;
  const currency = payment.currency || group.currency;
  const amountFloat = payment.amount; // TODO: clean this up when we switch all amounts to INTEGER
  const { interval } = payment;
  const isSubscription = _.contains(['month', 'year'], interval);
  const distribution = payment.distribution ? JSON.stringify({distribution: payment.distribution}) : '';

  if (interval && !isSubscription) {
    return next(new errors.BadRequest('Interval should be month or year.'));
  }

  if (!amountFloat) {
    return next(new errors.BadRequest('Payment Amount missing.'));
  }

  async.auto({

    getConnectedAccount: (cb) => {
      group.getConnectedAccount()
        .tap(connectedAccount => cb(null, connectedAccount))
        .catch(cb);
    },

    createSubscription: ['getConnectedAccount', (cb) => {
      if (isSubscription) {
        models.Subscription.create({
            amount: amountFloat,
            currency,
            interval
          })
        .then(subscription => cb(null, subscription))
        .catch(cb)
      } else {
        cb();
      }
    }],

    // We create the transaction beforehand to have the id in the return url when
    // the user logs on the PayPal website
    createTransaction: ['createSubscription', (cb, results) => {
      const payload = {
        group,
        transaction: {
          type: 'payment',
          amount: amountFloat,
          currency,
          description: `Donation to ${group.name}`,
          tags: ['Donation'],
          comment: distribution,
          // In paranoid mode, the deleted transactions are not visible
          // We will create that temporary transaction that will only be visible once
          // the user executes the paypal token
          deletedAt: new Date()
        }
      };

     if (isSubscription) {
        payload.subscription = results.createSubscription;
      }

      models.Transaction.createFromPayload(payload)
      .then(t => cb(null, t))
      .catch(cb);
    }],

    callPaypal: ['createTransaction', (cb, results) => {
      const connectedAccount = results.getConnectedAccount;
      const transaction = results.createTransaction;

      if (isSubscription) {
        paypal.createSubscription(
          connectedAccount,
          group,
          transaction,
          results.createSubscription
        , cb);
      } else {
        paypal.createPayment(
          connectedAccount,
          group,
          transaction
        , cb);
      }
    }],

    updateSubscription: ['callPaypal', (cb, results) => {
      if (!isSubscription) return cb();

      const transaction = results.createTransaction;

      transaction.getSubscription()
        .then((subscription) => {
          subscription.data = results.callPaypal.billingAgreement;

          return subscription.save();
        })
        .then(() => cb())
        .catch(cb);
    }]

  }, (e, results) => {
    if (e) {
      e.payload = req.body;
      return next(e);
    }

    const links = isSubscription
      ? results.callPaypal.billingAgreement.links
      : results.callPaypal.links

    res.send({
      success: true,
      links
    });
  });

};
export {paypalDonation as paypal};


export const paypalCallback = (req, res, next) => {
  const transaction = req.paranoidtransaction;
  const { group } = req;
  const { token } = req.query;

  // For single payments
  const { paymentId } = req.query;
  const { PayerID } = req.query;

  const isSubscription = !paymentId || !PayerID;

  if (!token) {
    return next(new errors.BadRequest('Token to execute agreement is missing'));
  }

  async.auto({
    getConnectedAccount: (cb) => {
      req.group.getConnectedAccount()
        .then(connectedAccount => cb(null, connectedAccount))
        .catch(cb);
    },

    execute: ['getConnectedAccount', (cb, results) => {
      paypal.execute(
        results.getConnectedAccount,
        req.query.token,
        req.query.paymentId,
        req.query.PayerID
      , cb)
    }],

    createActivity: ['execute', (cb, results) => {
      models.Activity.create({
        type: activities.WEBHOOK_PAYPAL_RECEIVED,
        data: {
          transaction: transaction.info,
          executionResult: results.execute
        }
      })
        .then(activity => cb(null, activity))
        .catch(cb);
    }],

    activateSubscription: ['createActivity', (cb, results) => {
      if (!isSubscription) return cb();

      transaction.getSubscription()
        .then(subscription => {
          const billingAgreementId = results.execute.id;
          subscription.data = _.extend({}, subscription.data, { billingAgreementId });
          subscription.isActive = true;

          return subscription.save();
        })
        .then(subscription => cb(null, subscription))
        .catch(cb);
    }],

    getOrCreateUser: ['activateSubscription', (cb, results) => {
      const { email } = results.execute.payer.payer_info;

      getOrCreateUser({ email }, cb);
    }],

    createDonation: ['getOrCreateUser', (cb, results) => {
      const user = results.getOrCreateUser;
      const { currency } = transaction;
      const amountFloat = transaction.amount; // TODO: clean this up when we switch all amounts to INTEGER
      const amountInt = parseInt(amountFloat * 100, 10); // TODO: clean this up when we switch all amounts to INTEGER
      const subscriptionId = results.activateSubscription && results.activateSubscription.id;

      const donation = {
        UserId: user.id,
        GroupId: group.id,
        currency,
        amount: amountInt,
        title: `Donation to ${group.name}`,
        SubscriptionId: subscriptionId
      };

      models.Donation.create(donation)
        .then(donation => transaction.setDonation(donation))
        .then(donation => cb(null, donation))
        .catch(cb);
    }],

    addUserToGroup: ['getOrCreateUser', (cb, results) => {
      const user = results.getOrCreateUser;

      models.UserGroup.findOne({
        where: {
          GroupId: group.id,
          UserId: user.id,
          role: roles.BACKER
        }
      })
      .then(userGroup => userGroup || group.addUserWithRole(user, roles.BACKER))
      .then(() => cb())
      .catch(cb);
    }],

    updateTransaction: ['addUserToGroup', (cb, results) => {
      transaction.restore() // removes the deletedAt field http://docs.sequelizejs.com/en/latest/api/instance/#restoreoptions-promiseundefined
        .then(() => transaction.setUser(results.getOrCreateUser))
        .then(() => models.Transaction.createActivity(transaction))
        .then(() => cb())
        .catch(cb);
    }]
  }, (err, results) => {
    if (err) return next(err);
    const user = results.getOrCreateUser;

    res.redirect(`${config.host.website}/${req.group.slug}?status=payment_success&userid=${user.id}&has_full_account=${user.info.hasFullAccount}`);
  });

};
