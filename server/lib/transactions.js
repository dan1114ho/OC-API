import Promise from 'bluebird';
import models from '../models';
import errors from '../lib/errors';
import { type } from '../constants/transactions';
import { getFxRate } from '../lib/currency';
import { exportToCSV } from '../lib/utils';
import { toNegative } from '../lib/math';

/**
 * Export transactions as CSV
 * @param {*} transactions 
 */
export function exportTransactions(transactions, attributes) {
  attributes = attributes || ['id', 'createdAt', 'amount', 'currency', 'description', 'netAmountInCollectiveCurrency', 'hostCurrency', 'hostCurrencyFxRate', 'paymentProcessorFeeInHostCurrency', 'hostFeeInHostCurrency', 'platformFeeInHostCurrency', 'netAmountInHostCurrency' ];

  return exportToCSV(transactions, attributes);
}

/**
 * Get transactions between startDate and endDate for collectiveids
 * @param {*} collectiveids 
 * @param {*} startDate 
 * @param {*} endDate 
 * @param {*} limit 
 */
export function getTransactions(collectiveids, startDate = new Date("2015-01-01"), endDate = new Date, options) {
  const where = options.where || {};
  const query = {
    where: {
      ...where,
      CollectiveId: { $in: collectiveids },
      createdAt: { $gte: startDate, $lt: endDate }
    },
    order: [ ['createdAt', 'DESC' ]]
  };
  if (options.limit) query.limit = options.limit;
  if (options.include) query.include = options.include;
  return models.Transaction.findAll(query);
}

export function createFromPaidExpense(host, paymentMethod, expense, paymentResponses, preapprovalDetails, UserId) {
  const hostCurrency = host.currency;
  let createPaymentResponse, executePaymentResponse;
  let fxrate;
  let paymentProcessorFeeInCollectiveCurrency = 0;
  let paymentProcessorFeeInHostCurrency = 0;
  let getFxRatePromise;

  // If PayPal
  if (paymentResponses) {

    createPaymentResponse = paymentResponses.createPaymentResponse;
    executePaymentResponse = paymentResponses.executePaymentResponse;

    switch (executePaymentResponse.paymentExecStatus) {
      case 'COMPLETED':
        break;

      case 'CREATED':
        /*
         * When we don't provide a preapprovalKey (paymentMethod.token) to payServices['paypal'](),
         * it creates a payKey that we can use to redirect the user to PayPal.com to manually approve that payment
         * TODO We should handle that case on the frontend
         */
        throw new errors.BadRequest(`Please approve this payment manually on ${createPaymentResponse.paymentApprovalUrl}`);

      default:
        throw new errors.ServerError(`controllers.expenses.pay: Unknown error while trying to create transaction for expense ${expense.id}`);
    }

    const senderFees = createPaymentResponse.defaultFundingPlan.senderFees;
    paymentProcessorFeeInCollectiveCurrency = senderFees.amount * 100; // paypal sends this in float

    const currencyConversion = createPaymentResponse.defaultFundingPlan.currencyConversion || { exchangeRate: 1 };
    fxrate = parseFloat(currencyConversion.exchangeRate); // paypal returns a float from host.currency to expense.currency
    paymentProcessorFeeInHostCurrency = 1/fxrate * paymentProcessorFeeInCollectiveCurrency;

    getFxRatePromise = Promise.resolve(fxrate);
  } else {
    // If manual (add funds or manual reimbursement of an expense)
    getFxRatePromise = getFxRate(expense.currency, host.currency, expense.incurredAt || expense.createdAt);
  }

  // We assume that all expenses are in Collective currency
  // (otherwise, ledger breaks with a triple currency conversion)
  const transaction = {
    netAmountInCollectiveCurrency: -1 * (expense.amount + paymentProcessorFeeInCollectiveCurrency),
    hostCurrency,
    paymentProcessorFeeInHostCurrency: toNegative(paymentProcessorFeeInHostCurrency),
    ExpenseId: expense.id,
    type: type.DEBIT,
    amount: -expense.amount,
    currency: expense.currency,
    description: expense.description,
    CreatedByUserId: UserId,
    CollectiveId: expense.CollectiveId,
    HostCollectiveId: host.id,
    PaymentMethodId: paymentMethod ? paymentMethod.id : null
  };

  return getFxRatePromise
    .then(fxrate => {
      if (!isNaN(fxrate)) {
        transaction.hostCurrencyFxRate = fxrate;
        transaction.amountInHostCurrency = -Math.round(fxrate * expense.amount); // amountInHostCurrency is an INTEGER (in cents)
      }
      return transaction;
    })
    .then(() => models.User.findById(UserId))
    .then(user => {
      transaction.FromCollectiveId = user.CollectiveId;
      return transaction;
    })
    .then(transaction => models.Transaction.createDoubleEntry(transaction));
  }

/** Calculate net amount of a transaction */
export function netAmount(tr) {
  return Math.round((
      tr.amountInHostCurrency +
      tr.hostFeeInHostCurrency +
      tr.platformFeeInHostCurrency +
      tr.paymentProcessorFeeInHostCurrency) * tr.hostCurrencyFxRate);
}

/** Verify net amount of a transaction */
export function verify(tr) {
  if (tr.type === 'CREDIT' && tr.amount <= 0) return 'amount <= 0';
  if (tr.type === 'DEBIT' && tr.amount >= 0) return 'amount >= 0';
  if (tr.type === 'CREDIT' && tr.netAmountInCollectiveCurrency <= 0) return 'netAmount <= 0';
  if (tr.type === 'DEBIT' && tr.netAmountInCollectiveCurrency >= 0) return 'netAmount >= 0';
  if (netAmount(tr) !== tr.netAmountInCollectiveCurrency) return 'netAmount diff';
  return true;
}

/** Calculate how off a transaction is
 *
 * Which is pretty much the difference between transaction net amount
 * & netAmountInCollectiveCurrency */
export function difference(tr) {
  return netAmount(tr) - tr.netAmountInCollectiveCurrency;
}
