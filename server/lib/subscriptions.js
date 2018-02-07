import config from 'config';
import moment from 'moment';
import { Op } from 'sequelize';

import models from '../models';
import emailLib from './email';
import * as paymentsLib from './payments';

/** Maximum number of attempts before an order gets cancelled. */
export const MAX_RETRIES = 3;

/** Find all orders with subscriptions that are active & due.
 *
 * Subscriptions are considered due if their `nextChargeDate` is
 * already past.
 */
export async function ordersWithPendingCharges() {
  return models.Order.findAll({
    where: { SubscriptionId: { [Op.ne]: null } },
    include: [
      { model: models.User, as: 'createdByUser'},
      { model: models.Collective, as: 'collective'},
      { model: models.Collective, as: 'fromCollective'},
      { model: models.PaymentMethod, as: 'paymentMethod'},
      { model: models.Subscription,
        where: {
          isActive: true,
          deletedAt: null,
          deactivatedAt: null,
          activatedAt: { [Op.lte]: new Date },
          nextChargeDate: { [Op.lte]: new Date }
        }
      }]
  });
}

/** Process order and trigger result handlers.
 *
 * Uses `lib.payments.processOrder()` to charge subscription and
 * handle both success and failure of that processing.
 */
export async function processOrderWithSubscription(options, order) {
  const csvEntry = {
    orderId: order.id,
    subscriptionId: order.Subscription.id,
    amount: order.totalAmount,
    from: order.fromCollective.slug,
    to: order.collective.slug,
    status: null,
    error: null,
    retriesBefore: order.Subscription.chargeRetryCount,
    retriesAfter: null,
    chargeDateBefore: dateFormat(order.Subscription.nextCharge),
    chargeDateAfter: null,
    nextPeriodStartBefore: dateFormat(order.Subscription.nextPeriodStart),
    nextPeriodStartAfter: null
  };

  let status = 'unattempted', transaction;
  if (!options.dryRun) {
    try {
      transaction = await paymentsLib.processOrder(order);
      status = 'success';
    } catch (error) {
      status = 'failure';
      csvEntry.error = error.message;
    }
  }

  updateNextChargeDate(status, order);
  updateChargeRetryCount(status, order);

  csvEntry.status = status;
  csvEntry.retriesAfter = order.Subscription.chargeRetryCount;
  csvEntry.chargeDateAfter = dateFormat(order.Subscription.nextChargeDate);
  csvEntry.nextPeriodStartAfter = dateFormat(order.Subscription.nextPeriodStart);

  if (!options.dryRun) {
    await handleRetryStatus(order, transaction);
    await order.Subscription.save();
  }

  return csvEntry;
}

/** Standard way to format dates in this script */
function dateFormat(date) {
  return moment(date).format();
}

/** Handle processing result.
 *
 * The result of processing an order is stored within the field
 * `chargeRetryCount`. This function handles the following values for
 * this variable:
 *
 *   1. zero(0): Means success. The counter was reset after a
 *      successful processing.
 *
 *   2. MAX_RETRIES: The order will be cancelled because it reached
 *      the maximum number of retries and the payment method doesn't
 *      work.
 *
 *   3. WARN_USER: The last attempt failed. Warn user about the
 *      failure and allow them to update the payment method.
 */
export async function handleRetryStatus(order, transaction) {
  switch (order.Subscription.chargeRetryCount) {
  case 0: await sendThankYouEmail(order, transaction); break;
  case MAX_RETRIES: cancelSubscriptionAndNotifyUser(order); break;
  //default: sendFailedEmail(order, false); break;
  }
}

/** Update the date an order should be charged again.
 *
 * The field `order.Subscription.nextChargeDate` is set to the next
 * date that the subscription should be charged.
 *
 * The status defines how much time it will take until the same
 * subscription can be charged again. Currently supported status
 * values:
 *
 *   0. new: 1st day of the next month for monthly, 1st day of the
 *      same month of the next year for yearly.
 *   1. success: Increment date by 1 month for monthly or 1 year for
 *      yearly subscriptions
 *   2. failure: Two days after today.
 */
export function updateNextChargeDate(status, order) {
  const initial = order.Subscription.nextPeriodStart || order.Subscription.createdAt;
  let nextDate = moment(initial);
  if (status === 'new' || status === 'success') {
    if (order.Subscription.interval === 'month') {
      nextDate.add(1, 'months');
    } else if (order.Subscription.interval === 'year') {
      nextDate.add(1, 'years');
    }
    if (status === 'new') {
      nextDate.startOf('month');
    }
    order.Subscription.nextPeriodStart = nextDate.toDate();
  } else if (status === 'failure') {
    nextDate = moment(new Date).add(2, 'days');
  }
  order.Subscription.nextChargeDate = nextDate.toDate();
}

/** Update counter that records retry attempts.
 *
 * When status is 'failure', `order.Subscription.chargeRetryCount` is
 * incremented by one. The counter is reset to zero if the status is
 * 'success'.
 */
export function updateChargeRetryCount(status, order) {
  order.Subscription.chargeRetryCount = (status === 'success')
    ? 0 : order.Subscription.chargeRetryCount + 1;
}

/** Cancel subscription
 *
 * The `isActive` field will be set to false and the field
 * `deactivatedAt` will be updated with the current time.
 *
 * Notice that this function doesn't save the changes to the database
 * so a call to `order.Subscription.save()` is required after this
 * function.
 */
export function cancelSubscription(order) {
  order.Subscription.isActive = false;
  order.Subscription.deactivatedAt = new Date;
}

/** Call cancelation function and then send confirmation email */
export async function cancelSubscriptionAndNotifyUser(order) {
  cancelSubscription(order);
  await sendFailedEmail(order, true);
}

/** Send `payment.failed` email */
export async function sendFailedEmail(order, lastAttempt) {
  const user = order.createdByUser;
  await emailLib.send('payment.failed', user.email, {
    lastAttempt,
    order: order.info,
    collective: order.collective.info,
    fromCollective: order.fromCollective.minimal
  }, {
    from: `${order.collective.name} <hello@${order.collective.slug}.opencollective.com>`
  });
}

/** Send `thankyou` email */
export async function sendThankYouEmail(order, transaction) {
  const relatedCollectives = await order.collective.getRelatedCollectives(2, 0);
  const user = order.createdByUser;
  await emailLib.send('thankyou', user.email, {
    order: order.info,
    transaction: transaction.info,
    user: user.info,
    firstPayment: false,
    collective: order.collective.info,
    fromCollective: order.fromCollective.minimal,
    relatedCollectives,
    config: { host: config.host },
    interval: order.Subscription.interval,
    subscriptionsLink: user.generateLoginLink('/subscriptions')
  }, {
    from: `${order.collective.name} <hello@${order.collective.slug}.opencollective.com>`
  });
}
