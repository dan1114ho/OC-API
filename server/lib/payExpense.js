const config = require('config');
const Promise = require('bluebird');
const uuid = require('node-uuid');

module.exports = app => {
  const services = {
    paypal: (groupId, expense, email, preapprovalKey) => {
      var uri = `/groups/${groupId}/transactions/${expense.id}/paykey/`;
      var baseUrl = config.host.webapp + uri;
      var amount = expense.amount;
      var payload = {
        requestEnvelope: {
          errorLanguage: 'en_US',
          detailLevel: 'ReturnAll'
        },
        actionType: 'PAY',
        currencyCode: expense.currency.toUpperCase() || 'USD',
        feesPayer: 'SENDER',
        memo: `Reimbursement transaction ${expense.id}: ${expense.description}`,
        trackingId: [uuid.v1().substr(0, 8), expense.id].join(':'),
        preapprovalKey,
        returnUrl: `${baseUrl}/success`,
        cancelUrl: `${baseUrl}/cancel`,
        receiverList: {
          receiver: [
            {
              email,
              amount,
              paymentType: 'SERVICE'
            }
          ]
        }
      };

      return Promise.promisify(app.paypalAdaptive.pay)(payload);
    }
  };

  return service => {
    const s = services[service];
    if (!s) {
      throw new errors.NotImplemented('This service is not implemented yet for payment.');
    }
    return s;
  };
};
