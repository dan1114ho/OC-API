/*
 * This script tells us which Stripe subscriptions are inactive
 */

import models from '../server/models';
import { retrieveSubscription } from '../server/gateways/stripe';
//const stripeGateway = require('../server/gateways').stripe;

const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

function run() {
  let inactiveSubscriptionCount = 0;
  let sumAmount = 0;
  return models.Order.findAll({
    where: { 
      SubscriptionId: {
        $ne: null
      },
      PaymentMethodId: {
        $ne: null
      }
    },
    include: [
      { model: models.Subscription,
        where: { 
          isActive: true,
          stripeSubscriptionId: {
            $ne: null
          } 
        }
      },
      { model: models.Collective, as: 'collective'},
      { model: models.PaymentMethod, as: 'paymentMethod' }
    ],
    order: ['id']
  })
  .tap(orders => console.log("Total Subscriptions found: ", orders.length))
  .each(order => {
    console.log(`Processing SubscriptionId: ${order.SubscriptionId}`);
    return order.collective.getHostStripeAccount()
      .then(stripeAccount => retrieveSubscription(stripeAccount, order.Subscription.stripeSubscriptionId))
      .then(stripeSubscription => {
        if (!stripeSubscription) {
          console.log('Stripe Subscription not found');
        } else {
          console.log('Subscription found!'); 
        }
      })
      .catch(err => {
        if (err.type === 'StripeInvalidRequestError') {
          console.log('Stripe Subscription not found - error thrown');
          inactiveSubscriptionCount +=1;
          if (order.currency === 'USD' || order.currency === 'EUR') {
            sumAmount += order.totalAmount;
          }
          const subscription = order.Subscription;
          subscription.isActive = false;
          subscription.deactivatedAt = new Date();
          return subscription.save();
        } else {
          console.log(err);
          Promise.resolve();
        }
      })
  })
  .then(() => console.log("Subscriptions marked inactive: ", inactiveSubscriptionCount))
  .then(() => console.log("Total amount reduced per month (in ~USD): ", sumAmount))
  .then(() => done())
  .catch(done)
}

run();