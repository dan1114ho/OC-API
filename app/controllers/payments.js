/**
 * Dependencies.
 */
var utils = require('../lib/utils');
var roles = require('../constants/roles');
var _ = require('lodash');
var async = require('async');
var Stripe = require('stripe');

var OC_FEE_PERCENT = 5;

/**
 * Controller.
 */
module.exports = function(app) {

  /**
   * Internal Dependencies.
   */
  var models = app.set('models');
  var errors = app.errors;
  var transactions = require('../controllers/transactions')(app);
  var users = require('../controllers/users')(app);
  var emailLib = require('../lib/email')(app);

  var getOrCreatePlan = function(params, cb) {
    var stripe = params.stripe;
    var plan = params.plan;

    stripe.plans.retrieve(plan.id, function(err, result) {
      var type = err && err.type;
      var message = err && err.message;

      if (type === 'StripeInvalidRequest' && _.contains(message, 'No such plan')) {
        stripe.plans.create(plan, cb);
      } else {
        cb(err, result);
      }
    });
  };

  /**
   * Public methods.
   */
  return {

    /**
     * Return a plan or creates a new one
     * Exposed for testing
     */
    getOrCreatePlan: getOrCreatePlan,

    /**
     * Post a payment.
     */
    post: function(req, res, next) {
      var payment = req.required.payment;
      var user = req.remoteUser;
      var email = payment.email;
      var group = req.group;
      var interval = payment.interval;
      var isSubscription = _.contains(['month', 'year'], interval);
      var hasFullAccount = false; // Used to specify if a user has a real account

      if (interval && !isSubscription) {
        return next(new errors.BadRequest('Interval should be month or year.'));
      }

      if (!payment.stripeToken) {
        return next(new errors.BadRequest('Stripe Token missing.'));
      }

      if (!payment.amount) {
        return next(new errors.BadRequest('Payment Amount missing.'));
      }

      async.auto({

        getGroupStripeAccount: function(cb) {
          req.group.getStripeAccount(function(err, stripeAccount) {
            if (err) return cb(err);
            if (!stripeAccount || !stripeAccount.accessToken) {
              return cb(new errors.BadRequest('The host for the collective id ' + req.group.id + ' has no Stripe account set up'));
            }

            cb(null, Stripe(stripeAccount.accessToken));
          });
        },

        getExistingCard: ['getGroupStripeAccount', function(cb) {
          models.Card
            .findOne({
              where: {
                token: payment.stripeToken,
                service: 'stripe'
              }
            })
            .then(function(card) {
              cb(null, card);
            })
            .catch(cb);
        }],

        createCustomer: ['getGroupStripeAccount', 'getExistingCard', function(cb, results) {
          var stripe = results.getGroupStripeAccount;

          if (results.getExistingCard) {
            return cb(null, results.getExistingCard);
          }

          stripe.customers
            .create({
              source: payment.stripeToken,
              description:  'Paying ' + email + ' to ' + group.name,
              email: email
            }, cb);
        }],

        createCard: ['createCustomer', 'getExistingCard', function(cb, results) {
          if (results.getExistingCard) {
            return cb(null, results.getExistingCard);
          }

          models.Card
            .create({
              token: payment.stripeToken,
              serviceId: results.createCustomer.id,
              service: 'stripe',
              UserId: user && user.id,
              GroupId: group.id
            })
            .done(cb);
        }],

        /**
         * For one-time donation
         */

        createCharge: ['getGroupStripeAccount', 'createCard', function(cb, results) {
          var stripe = results.getGroupStripeAccount;
          var card = results.createCard;
          var amount = payment.amount * 100;
          var currency = payment.currency || group.currency;

          /**
           * Subscription
           */
          if (isSubscription) {
            var id = utils.planId({
              currency,
              interval,
              amount
            });

            getOrCreatePlan({
              plan: {
                id,
                interval,
                amount,
                name: id,
                currency
              },
              stripe
            }, function(err, plan) {
              if (err) return cb(err);

              stripe.customers
                .createSubscription(card.serviceId, {
                  plan: plan.id,
                  application_fee_percent: OC_FEE_PERCENT
                }, cb);
            });

          } else {

            /**
             * For one-time donation
             */
            stripe.charges
              .create({
                amount: amount,
                currency: currency,
                customer: card.serviceId,
                description: 'One time donation to ' + group.name,
                metadata: {
                  groupId: group.id,
                  groupName: group.name,
                  customerEmail: email,
                  cardId: card.id
                }
              }, cb);
          }
        }],

        /*
         *  Creates a user in our system to associate with this transaction
         */

        getOrCreateUser: ['createCharge', function(cb) {
          return models.User.findOne({
            where: {
              email: email
            }
          })
          .then(function(user) {
            if (user) {
              hasFullAccount = (user.password_hash ? true : false);
              cb(null, user);
            } else {
              users._create({
                email: email
              }, cb);
            }
          })
          .catch(cb);
        }],

        createTransaction: ['getOrCreateUser', 'createCard', 'createCharge', function(cb, results) {
          var charge = results.createCharge;
          var user = results.getOrCreateUser;

          var description = ['Donation to', group && group.name].join(' ');
          var transaction = {
            type: 'payment',
            amount: payment.amount,
            currency: charge.currency || charge.plan.currency,
            paidby: user && user.id,
            description,
            tags: ['Donation'],
            approved: true,
            interval
          };

          if (isSubscription) {
            transaction.stripeSubscriptionId = charge.id;

            // We will put this transaction on pending until we get the first invoice
            // from the webhook. This needs to be refactored when we have a separation
            // between transactions and payments.
            transaction.isWaitingFirstInvoice = true;
          }

          [
            'description',
            'beneficiary',
            'paidby',
            'tags',
            'status',
            'link',
            'comment',
            'interval'
          ].forEach((prop) => {
            if (payment[prop])
              transaction[prop] = payment[prop];
          });

          transactions._create({
            transaction,
            user,
            group,
            card: results.createCard
          }, cb);
        }],

        sendThankYouEmail: ['createTransaction', function(cb, results) {
          const user = results.getOrCreateUser;
          const transaction = results.createTransaction;
          const data = {
            transaction: transaction.info,
            user: user.info,
            group: group.info
          }
          var template = 'thankyou';
          if(group.name.match(/WWCode/i))
            template += '.wwcode';

          emailLib.send(template, user.email, data);
          cb();
        }],

        addUserToGroup: ['createTransaction', function(cb, results) {
          user = results.getOrCreateUser;

          group
            .hasUser(user)
            .then(function(isMember) {
              if (isMember)
                return cb();
              else {
                group
                  .addUser(user, {role: roles.BACKER})
                  .done(cb);
              }
            })
            .catch(cb);
        }]

      }, function(e) {
        if (e) return next(e);

        res.send({success: true, user: user.info, hasFullAccount: hasFullAccount});
      });

    }

  }
};
