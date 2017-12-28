import argparse from 'argparse'

import models from '../server/models';
import * as stripeGateway from '../server/paymentProviders/stripe/gateway';
import * as constants from '../server/constants/transactions';


/*
  - Find all subscriptions on oldStripeAccount
  - For each one that exists in our database, create new customer based on:
    case 1: Old data 
      only has pm.customerId
    case 2: Post-v2 migration data
      has pm.customerId and data.CustomerIdForHost
    case 3: Post-v2 already created a CustomerIdFor this host
      has pm.customerId and data.CustomerIdForHost[newStripeAccount.username]

  - Record new customer info
  - Create plan and add new subscription.
  - Cancel old subscription

*/

let sharedCustomersCount = 0, nonSharedCustomersCount = 0, subsUpdatedCount = 0, subsSkippedCount = 0;

const done = (err) => {
  if (err) console.log('err', err);
  console.log('Non-shared customers found: ', nonSharedCustomersCount);
  console.log('Shared customers found: ', sharedCustomersCount);
  console.log('Total subscriptions updated: ', subsUpdatedCount);
  console.log('Total subscriptions skipped: ', subsSkippedCount);
  console.log('done!');
  process.exit();
}

const migrateSubscriptions = (options) => {
  const { oldStripeAccountId, newStripeAccountId, limit, dryRun } = options;


  let oldStripeAccount, newStripeAccount, currentOCSubscription;
  // fetch old stripe account
  return models.ConnectedAccount.findById(oldStripeAccountId)
  .then(stripeAccount => {
    if (!stripeAccount) {
      throw new Error('Old stripe account not found');
    }
    oldStripeAccount = stripeAccount
  })

  // fetch new stripe account
  .then(() => models.ConnectedAccount.findById(newStripeAccountId))
  .then(stripeAccount => {
    if (!stripeAccount) {
      throw new Error('New stripe account not found')
    }
    newStripeAccount = stripeAccount
  })

  // fetch subscriptions from old stripe account
  .then(() => stripeGateway.getSubscriptionsList(oldStripeAccount, limit))

  .then(oldStripeSubscriptionList => {
    console.log("Subscriptions fetched: ", oldStripeSubscriptionList.data.length);
    return oldStripeSubscriptionList.data;
  })
  .each(oldStripeSubscription => {
    if (options.verbose) {
      console.log("\n---OLD SUBSCRIPTION---")
      console.log(oldStripeSubscription);
      console.log("---------END----------")
    } else {
      console.log("\nProcessing subscription: ", oldStripeSubscription.id);
    }

    let platformCustomerId, customerIdOnOldStripeAccount, customerIdOnNewStripeAccount;

    // fetch the subscription from our database
    return models.Subscription.findOne({where: { stripeSubscriptionId: oldStripeSubscription.id}})
      .then(ocSubscription => {
        if (ocSubscription && ocSubscription.isActive) {
          console.log("Subscription found in our DB:", ocSubscription.id)
          currentOCSubscription = ocSubscription;
        } else {
          throw new Error("Subscription not found in our DB: ", oldStripeSubscription.id)
        }
      })

      // fetch order with paymentMethod and other info used for this subscription
      .then(() => {
        return models.Order.find({
          where: {
            SubscriptionId: currentOCSubscription.id
          },
          include: [
          { model: models.Subscription },
          { model: models.PaymentMethod, as: 'paymentMethod'},
          { model: models.User, as: 'createdByUser' }
          ]
        })
      })
      .then(order => {
        const pm = order.paymentMethod;
        const customerIdForHostsList = pm.data && pm.data.CustomerIdForHost;

        platformCustomerId = pm.customerId;
        customerIdOnOldStripeAccount = customerIdForHostsList && customerIdForHostsList[oldStripeAccount.username];
        customerIdOnNewStripeAccount = customerIdForHostsList && customerIdForHostsList[newStripeAccount.username];

        const processSubscription = () => {

          if (dryRun) {
            console.log('Dry run: Exiting without making any changes on Stripe')
            subsUpdatedCount += 1
            return Promise.resolve();
          }
          // create plan
          const plan = {
            interval: oldStripeSubscription.plan.interval,
            amount: oldStripeSubscription.plan.amount,
            currency: oldStripeSubscription.plan.currency
          }
          return stripeGateway.getOrCreatePlan(newStripeAccount, plan)

          // add a new subscription
          .then(stripeSubscriptionPlan => {
            const subscription = {
              // carryover fields
              plan: stripeSubscriptionPlan.id,
              application_fee_percent: constants.OC_FEE_PERCENT,
              metadata: oldStripeSubscription.metadata,
              // needed to make sure we don't double charge them
              billing_cycle_anchor: oldStripeSubscription.current_period_end,
              prorate: false
            };
            return stripeGateway.createSubscription(
              newStripeAccount,
              customerIdOnNewStripeAccount,
              subscription);
          })

          // store the new stripeSubscription info in our table
          .then(newStripeSubscription => {
            const preMigrationData = currentOCSubscription.data;

            return currentOCSubscription.updateAttributes({
              data: Object.assign({}, newStripeSubscription, { preMigrationData }),
              stripeSubscriptionId: newStripeSubscription.id
            });
          })
          // delete new subscription from stripe
          .then(() => stripeGateway.cancelSubscription(
            oldStripeAccount, oldStripeSubscription.id))
          .catch(err => {
            console.log("ERROR: ", err, oldStripeSubscription)
            return err;
          })
        }

        // we shouldn't have any active subscriptions on stripe without customerId
        // on paymentMethod
        if (!platformCustomerId) {
          throw new Error("Payment Method found without Customer Id: ", pm.id);
        }

        // figure out which of the three cases this payment method falls into
        /*
          Case 1: old subscription
            -- pm.data.CustomerIdForHost is null
            -- Check for customerId is moved over by stripe, otherwise skip
          Case 2: post-v2 subscription
            -- pm.data.CustomerIdForHost[oldStripeAccount.username] is not null
            -- Create customerId on newStripeAccount and update PM
          Case 3: post-v2 subscription and user already has a customer Id on new stripe account
            -- pm.data.CustomerIdForHost[oldStripeAccount.username] is not null and pm.data.CustomerIdForHost[newStripeAccount.username] is not null
            -- Nothing needed in terms of Customer Id in this case
        */

        if (!customerIdOnOldStripeAccount && !customerIdOnNewStripeAccount) {
          // Case 3
          console.log("Non-shared customer Id found, checking for customer on new Stripe Account")

          nonSharedCustomersCount += 1;
          return stripeGateway.retrieveCustomer(newStripeAccount, oldStripeSubscription.customer)
            .then(() => {
              return processSubscription();
            })
            // if customer not found, stripe will throw this error
            .catch(err => {
              if (err.message.indexOf('No such customer') !== -1) {
                console.log('Customer not found on new stripe account, skipping')
                subsSkippedCount += 1;
              } else {
                return done(err)
              }
            })
        } else if (customerIdOnOldStripeAccount && !customerIdOnNewStripeAccount) {
          // Case 2
          console.log("Shared Customer id found on old stripe account, creating one on new stripe acount")

          sharedCustomersCount += 1;
          if (dryRun) {
            console.log('Dry run: Exiting without making any changes on Stripe');
            return Promise.resolve();
          }

          return stripeGateway.createToken(newStripeAccount, platformCustomerId)
            .then(stripeCustomer => {
              customerIdOnNewStripeAccount = stripeCustomer.id;
              const pmData = pm.data;
              pmData.customerIdForHost = Object.assign({}, pmData.customerIdForHost, {[newStripeAccount.username]: stripeCustomer.id})
              return pm.update({data: pmData})
                .then(() => processSubscription())
            })
        }
      })
  })
}

const run = () => {
  console.log('\nStarting migrate_subscriptions_in_stripe...')

  const parser = new argparse.ArgumentParser({
    addHelp:true,
    description: 'Migrate stripe subscriptions from one host to another'
  });
  parser.addArgument(
    [ '-f', '--fromId'],
    {
      help: 'Stripe ConnectedAccount Id of Host to move FROM',
      required: true
    }
  );
  parser.addArgument(
    ['-t', '--toHostCollectiveId'],
    {
      help: 'Stripe ConnectedAccount Id of Host to move TO',
      required: true
    }
  );
  parser.addArgument(
    [ '-l', '--limit' ],
    {
      help: 'how many subscriptions to fetch at a time'
    }
  );
  parser.addArgument(
    [ '--notdryrun' ],
    {
      help: 'this flag indicates it\'s not a dry run',
      defaultValue: false,
      action: 'storeConst',
      constant: true
    }
  );
  parser.addArgument(
    [ '--verbose'],
    {
      help: 'verbose output',
      defaultValue: false,
      action: 'storeConst',
      constant: true
    })

  const args = parser.parseArgs();

  const options = {
    oldStripeAccountId: args.fromId,
    newStripeAccountId: args.toId,
    dryRun: !args.notdryrun,
    limit: args.limit || 1,
    verbose: args.verbose
  }

  console.log("Using args: ", options);

  return migrateSubscriptions(options)
  .catch(done)
}

run();
