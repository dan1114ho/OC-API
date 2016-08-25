/**
 * Dependencies.
 */

import _ from 'lodash';
import Promise from 'bluebird';
import activities from '../constants/activities';
import includes from 'lodash/collection/includes';
import status from '../constants/expense_status';
import utils from '../lib/utils';
import roles from '../constants/roles';
import transactions from '../lib/transactions';
import paypalImport from './paypal';
import payExpenseImport from '../lib/payExpense';

/**
 * Controller.
 */

export default (app) => {

  const { errors } = app;
  const models = app.set('models');
  const createTransaction = transactions(app).createFromPaidExpense;
  const paypal = paypalImport(app);
  const payExpense = payExpenseImport(app);

  const getPreapprovalDetails = Promise.promisify(paypal.getPreapprovalDetails);

  /**
   * Create an expense.
   */

  const create = (req, res, next) => {
    const user = req.remoteUser || req.user;
    const { group } = req;
    const attributes = Object.assign({}, req.required.expense, {
      UserId: user.id,
      GroupId: group.id,
      lastEditedById: user.id
    });
    // TODO make sure that the payoutMethod is also properly stored in DB, then propagated to Transaction when paying
    models.Expense.create(attributes)
      .then(expense => models.Expense.findById(expense.id, { include: [ models.Group, models.User ]}))
      .tap(expense => createActivity(expense, activities.GROUP_EXPENSE_CREATED))
      .tap(expense => res.send(expense))
      .catch(next);
  };

  /**
   * Get an expense.
   */
  const getOne = (req, res) => res.json(req.expense.info);

  /**
   * Get expenses.
   */
  const list = (req, res, next) => {

    const query = Object.assign({
      where: { GroupId: req.group.id },
      order: [[req.sorting.key, req.sorting.dir]]
    }, req.pagination);

    return models.Expense.findAndCountAll(query)
      .then(expenses => {
        // Set headers for pagination.
        req.pagination.total = expenses.count;
        res.set({ Link: utils.getLinkHeader(utils.getRequestedUrl(req), req.pagination) });
        res.send(_.pluck(expenses.rows, 'info'));
      })
      .catch(next);
  };

  /**
   * Delete an expense.
   */

  const deleteExpense = (req, res, next) => {
    const { expense } = req;
    const user = req.remoteUser || req.user;

    assertExpenseStatus(expense, status.REJECTED)
      .then(() => expense.lastEditedById = user.id)
      .then(() => expense.save())
      .then(() => expense.destroy())
      .tap(expense => createActivity(expense, activities.GROUP_EXPENSE_DELETED))
      .tap(() => res.send({success: true}))
      .catch(next);
  };

  const update = (req, res, next) => {
    const origExpense = req.expense;
    const newExpense = req.required.expense;
    const user = req.remoteUser || req.user;
    const modifiableProps = [
      'amount',
      'attachment',
      'category',
      'comment',
      'incurredAt',
      'currency',
      'notes',
      'payoutMethod',
      'title',
      'vat'
    ];

    assertExpenseStatus(origExpense, status.PENDING)
      .tap(() => {
        modifiableProps.forEach(prop => origExpense[prop] = newExpense[prop] || origExpense[prop]);
        origExpense.updatedAt = new Date();
        origExpense.lastEditedById = user.id;
      })
      .then(() => origExpense.save())
      .tap(expense => createActivity(expense, activities.GROUP_EXPENSE_UPDATED))
      .tap(expense => res.send(expense.info))
      .catch(next);
  };

  /**
   * Approve or reject an expense.
   */

  const setApprovalStatus = (req, res, next) => {
    const user = req.remoteUser || req.user;
    const { expense } = req;
    let preapprovalDetails;

    assertExpenseStatus(expense, status.PENDING)
      .then(() => {
        if (req.required.approved === false) {
          return expense.setRejected(user.id)
            .tap(exp => createActivity(exp, activities.GROUP_EXPENSE_REJECTED))
        }
        if (expense.payoutMethod === 'manual') {
          return models.Group.findById(expense.GroupId)
            .then(group => group.getBalance())
            .then(checkIfEnoughFunds(expense))
            .then(() => expense.setApproved(user.id))
            .tap(expense => createActivity(expense, activities.GROUP_EXPENSE_APPROVED))
        } else {
           return models.UserGroup.findOne({
            where: {
              GroupId: expense.GroupId,
              role: roles.HOST
            }
          })
          .then(userGroup => fetchPaymentMethod(userGroup.UserId))
          .then(paymentMethod => getPreapprovalDetails(paymentMethod.token))
          .tap(d => preapprovalDetails = d)
          .then(checkIfEnoughFunds(expense))
          .then(() => expense.setApproved(user.id))
          .tap(expense => createActivity(expense, activities.GROUP_EXPENSE_APPROVED))
        }
      })
      .then(() => res.send({success: true}))
      .catch(err => next(formatError(err, preapprovalDetails)));

    function fetchPaymentMethod(UserId) {
      return models.PaymentMethod.findOne({
        where: {
          service: 'paypal',
          UserId
        }
      })
      .then(paymentMethod => {
        if (!paymentMethod || !paymentMethod.token) {
          return new errors.BadRequest("You can't approve an expense without linking your PayPal account");
        }
        return paymentMethod;
      });
    }

    function checkIfEnoughFunds(expense) {
      const txAmount = expense.amount/100;
      if (expense.payoutMethod === 'manual') {
        return balance => {
          if (balance >= expense.amount) {
            return Promise.resolve();
          } else {
            return Promise.reject(new errors.BadRequest(`Not enough funds in this collective to approve this request. Please add funds first.`));
          }
        }
      } else {
        return details => {
          const maxAmount = Number(details.maxTotalAmountOfAllPayments) - Number(details.curPaymentsAmount);
          const currency = details.currencyCode;

          if (Math.abs(txAmount) > maxAmount) {
            return Promise.reject(new errors.BadRequest(`Not enough funds (${maxAmount} ${currency} left) to approve expense.`));
          }
          return Promise.resolve();
        };
      }

    }
  };

  /**
   * Pay (reimburse) an approved expense.
   */

  const pay = (req, res, next) => {
    const user = req.remoteUser || req.user;
    const { expense } = req;
    const { payoutMethod } = req.expense;
    const isManual = !includes(models.PaymentMethod.payoutMethods, payoutMethod);
    let paymentMethod, email, paymentResponse, preapprovalDetails;

    assertExpenseStatus(expense, status.APPROVED)
      .then(() => isManual ? null : getPaymentMethod())
      .tap(m => paymentMethod = m)
      .then(getBeneficiaryEmail)
      .tap(e => email = e)
      .then(() => isManual ? null : pay())
      .tap(r => paymentResponse = r)
      .then(() => isManual ? null : getPreapprovalDetails(paymentMethod.token))
      .tap(d => preapprovalDetails = d)
      .then(() => createTransaction(payoutMethod, paymentMethod, expense, paymentResponse, preapprovalDetails, user.id))
      .tap(() => expense.setPaid(user.id))
      .tap(() => res.json(expense))
      .catch(err => next(formatError(err, paymentResponse)));

    function getPaymentMethod() {
      // Use first paymentMethod found
      return models.PaymentMethod.findOne({
        where: {
          service: payoutMethod,
          UserId: req.remoteUser.id,
          confirmedAt: {$ne: null}
        },
        order: [['confirmedAt', 'DESC']]
      })
      .tap(paymentMethod => {
        if (!paymentMethod) {
          throw new errors.BadRequest('This user has no confirmed paymentMethod linked with this service.');
        }
      });
    }

    function getBeneficiaryEmail() {
      return expense.getUser().then(user => user.paypalEmail || user.email);
    }

    /**
     * TODO Verify enough money left on preapprovalKey (paymentMethod.token).
     * If we send it to payServices['paypal'] with not enough money left, it will fail (gracefully).
     * If we don't send it, it will return a `paymentApprovalUrl` that we can use to redirect the user
     * to PayPal.com to manually approve the payment.
     */
    function pay() {
      const preapprovalKey = paymentMethod.token;
      return payExpense(payoutMethod)(req.group, expense, email, preapprovalKey);
    }
  };

  return {
    create,
    getOne,
    list,
    deleteExpense,
    update,
    setApprovalStatus,
    pay
  };

  function assertExpenseStatus(expense, status) {
    if (expense.status !== status) {
      return Promise.reject(new errors.BadRequest(`Expense ${expense.id} status should be ${status}.`));
    }
    return Promise.resolve();
  }

  function createActivity(expense, type) {
    return models.Activity.create({
      type,
      UserId: expense.User.id,
      GroupId: expense.Group.id,
      data: {
        group: expense.Group.info,
        user: expense.User.info,
        expense: expense.info
      }
    });
  }

  function formatError(err, paypalResponse) {
    if (paypalResponse) {
      console.error('PayPal error', JSON.stringify(paypalResponse));
      if (paypalResponse.error instanceof Array) {
        const { message } = paypalResponse.error[0];
        return new errors.BadRequest(message);
      }
    }
    return err;
  }
};
