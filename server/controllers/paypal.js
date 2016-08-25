/**
 * Dependencies.
 */
import async from 'async';
import config from 'config';
import moment from 'moment';

/**
 * Controller.
 */
export default function(app) {

  /**
   * Internal Dependencies.
   */
  const models = app.set('models');
  const { Activity } = models;
  const { PaymentMethod } = models;
  const { errors } = app;

  /**
   * Get Preapproval Details.
   */
  const getPreapprovalDetails = function(preapprovalKey, callback) {
    const payload = {
      requestEnvelope: {
        errorLanguage:  'en_US',
        detailLevel:    'ReturnAll'
      },
      preapprovalKey
    };

    callPaypal('preapprovalDetails', payload, callback);
  };

  /**
   * Get preapproval details route
   */
  const getDetails = function(req, res, next) {
    const preapprovalKey = req.params.preapprovalkey;

    getPreapprovalDetails(preapprovalKey, (err, response) => {
      if (err) return next(err);
      res.json(response);
    });
  };

  /**
   * Get a preapproval key for a user.
   */
  const getPreapprovalKey = function(req, res, next) {
    // TODO: This return and cancel URL doesn't work - no routes right now.
    const uri = `/users/${req.remoteUser.id}/paypal/preapproval/`;
    const baseUrl = config.host.webapp + uri;
    const cancelUrl = req.query.cancelUrl || (`${baseUrl}/cancel`);
    const returnUrl = req.query.returnUrl || (`${baseUrl}/success`);
    const endingDate = (req.query.endingDate && (new Date(req.query.endingDate)).toISOString()) || moment().add(1, 'years').toISOString();
    const maxTotalAmountOfAllPayments = req.query.maxTotalAmountOfAllPayments || 2000; // 2000 is the maximum: https://developer.paypal.com/docs/classic/api/adaptive-payments/Preapproval_API_Operation/

    async.auto({

      getExistingPaymentMethod: [function(cb) {
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id
            }
          })
          .then(paymentMethods => cb(null, paymentMethods))
          .catch(cb);
      }],

      checkExistingPaymentMethod: ['getExistingPaymentMethod', function(cb, results) {
        async.each(results.getExistingPaymentMethod.rows, (paymentMethod, cbEach) => {
          if (!paymentMethod.token) {
            return paymentMethod.destroy()
              .then(() => cbEach())
              .catch(cbEach);
          }

          getPreapprovalDetails(paymentMethod.token, (err, response) => {
            if (err) return cbEach(err);
            if (response.approved === 'false' || new Date(response.endingDate) < new Date()) {
              paymentMethod.destroy()
                .then(() => cbEach())
                .catch(cbEach);
            } else {
              cbEach();
            }
          });
        }, cb);
      }],

      createPaymentMethod: ['checkExistingPaymentMethod', function(cb) {
        PaymentMethod.create({
          service: 'paypal',
          UserId: req.remoteUser.id
        })
        .then(paymentMethod => cb(null, paymentMethod))
        .catch(cb);
      }],

      createPayload: ['createPaymentMethod', function(cb, results) {
        const payload = {
          currencyCode: 'USD',
          startingDate: new Date().toISOString(),
          endingDate,
          returnUrl,
          cancelUrl,
          displayMaxTotalAmount: false,
          feesPayer: 'SENDER',
          maxTotalAmountOfAllPayments,
          requestEnvelope: {
            errorLanguage:  'en_US'
          },
          clientDetails: results.createPaymentMethod.id
        };
        return cb(null, payload);
      }],

      callPaypal: ['createPayload', function(cb, results) {
        app.paypalAdaptive.preapproval(results.createPayload, cb);
      }],

      updatePaymentMethod: ['createPaymentMethod', 'createPayload', 'callPaypal', function(cb, results) {
        const paymentMethod = results.createPaymentMethod;
        paymentMethod.token = results.callPaypal.preapprovalKey;
        paymentMethod.save()
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }]

    }, (err, results) => {
      if (err) return next(err);
      res.json(results.callPaypal);
    });

  };

  /**
   * Confirm a preapproval.
   */
  const confirmPreapproval = function(req, res, next) {

    async.auto({

      getPaymentMethod: [function(cb) {
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id,
              token: req.params.preapprovalkey
            }
          })
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      checkPaymentMethod: ['getPaymentMethod', function(cb, results) {
        if (results.getPaymentMethod.rows.length === 0) {
          return cb(new errors.NotFound('This preapprovalKey doesn not exist.'));
        } else {
          cb();
        }
      }],

      callPaypal: [function(cb) {
        getPreapprovalDetails(req.params.preapprovalkey, (err, response) => {
          if (err) {
            return cb(err);
          }

          if (response.approved === 'false') {
            return cb(new errors.BadRequest('This preapprovalkey is not approved yet.'));
          }

          cb(null, response);
        });
      }],

      updatePaymentMethod: ['callPaypal', 'getPaymentMethod', 'checkPaymentMethod', function(cb, results) {
        const paymentMethod = results.getPaymentMethod.rows[0];
        paymentMethod.confirmedAt = new Date();
        paymentMethod.data = results.callPaypal;
        paymentMethod.number = results.callPaypal.senderEmail;
        paymentMethod.save()
          .then(paymentMethod => cb(null, paymentMethod))
          .catch(cb);
      }],

      cleanOldPaymentMethods: ['updatePaymentMethod', function(cb) {
        PaymentMethod
          .findAndCountAll({
            where: {
              service: 'paypal',
              UserId: req.remoteUser.id,
              token: {$ne: req.params.preapprovalkey}
            }
          })
          .then((results) => {
            async.each(results.rows, (paymentMethod, cbEach) => {
              paymentMethod.destroy()
                .then(() => cbEach())
                .catch(cbEach);
            }, cb);
          })
          .catch(cb);
      }],

      createActivity: ['updatePaymentMethod', function(cb, results) {
        Activity.create({
          type: 'user.paymentMethod.created',
          UserId: req.remoteUser.id,
          data: {
            user: req.remoteUser,
            paymentMethod: results.updatePaymentMethod
          }
        })
        .then(activity => cb(null, activity))
        .catch(cb);
      }]

    }, (err, results) => {
      if (err) return next(err);
      else res.json(results.updatePaymentMethod.info);
    });

  };

  /**
   * Public methods.
   */
  return {
    getPreapprovalKey,
    confirmPreapproval,
    getDetails,
    getPreapprovalDetails
  };

  function callPaypal(endpointName, payload, callback) {
    console.log(`calling PayPal ${endpointName} with payload:`, payload); // leave this in permanently to help with paypal debugging
    app.paypalAdaptive[endpointName](payload, (err, res) => {
      console.log("PayPal response: ", res);
      if (err) {
        console.log(`PayPal ${endpointName} error: `, err);
        if (res.error && res.error[0] && res.error[0].parameter) {
          console.log("PayPal error.parameter: ", res.error[0].parameter); // this'll give us more details on the error
        }
        callback(new Error(res.error[0].message));
      }
      callback(null, res);
    });
  }
};
