const app = require('../index');
const expect = require('chai').expect;
const request = require('supertest-as-promised');
const sinon = require('sinon');
const utils = require('./utils')();
const roles = require('../server/constants/roles');
const badRequest = require('./lib/expectHelpers').badRequest;
const missingRequired = require('./lib/expectHelpers').missingRequired;
const paypalMock = require('./mocks/paypal');
const payMock = paypalMock.adaptive.payCompleted;
const preapprovalDetailsMock = Object.assign({}, paypalMock.adaptive.preapprovalDetails.completed);

const models = app.get('models');
const expense = utils.data('expense1');
const Activity = models.Activity;
const Expense = models.Expense;
const Transaction = models.Transaction;
const PaymentMethod = models.PaymentMethod;

describe('expenses.routes.test.js', () => {
  var application, user, group;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => models.User.create(utils.data('user1')).tap(u => user = u));

  beforeEach(() => models.Group.create(utils.data('group1')).tap(g => group = g));

  beforeEach(() => group.addUserWithRole(user, roles.HOST));

  describe('WHEN expense does not exist', () => {
    var req;

    describe('#approve', () => {
      beforeEach(() => {
        req = request(app)
          .post('/groups/' + group.id + '/expenses/123/approve')
          .set('Authorization', `Bearer ${user.jwt(application)}`);
      });

      it('THEN returns 404', () => req.expect(404));
    });

    describe('#delete', () => {
      beforeEach(() => {
        req = request(app)
          .delete(`/groups/${group.id}/expenses/123`)
          .set('Authorization', `Bearer ${user.jwt(application)}`);
      });

      it('THEN returns 404', () => req.expect(404));
    });
  });

  describe('#create', () => {
    var createReq;

    beforeEach(() => {
      createReq = request(app).post(`/groups/${group.id}/expenses`);
    });

    describe('WHEN not authenticated but providing an expense', () => {
      beforeEach(() => {
        createReq = createReq.send({ expense });
      });

      it('THEN returns 200 with expense', () =>
        createReq
          .expect(200)
          .then(res => {
            expect(res.body.UserId).not.to.be.equal(user.id);
            expect(res.body.GroupId).to.be.equal(group.id);
            expect(res.body.title).to.be.equal(expense.title);
            expect(res.body.notes).to.be.equal(expense.notes);
            expect(res.body.category).to.be.equal(expense.category);
            expect(res.body.amount).to.be.equal(expense.amount);
            expect(res.body.currency).to.be.equal(expense.currency);
          }));
    });

    describe('WHEN submitting expense with negative amount', () => {
      beforeEach(() => {
        createReq = createReq.send({ expense: Object.assign({}, expense, { amount: -1 }) });
      });

      it('THEN returns 400', () => createReq.expect(400, {
        error: {
          code: 400,
          type: 'validation_failed',
          message: 'Validation error: Validation min failed',
          fields: [ 'amount' ]
        }
      }));
    });

    // authenticate even though not required, so that we can make assertions on the userId
    describe('WHEN authenticated', () => {

      beforeEach(() => {
        createReq = createReq.set('Authorization', `Bearer ${user.jwt(application)}`);
      });

      describe('WHEN not providing expense', () =>
        it('THEN returns 400', () => missingRequired(createReq, 'expense')));

      describe('WHEN providing expense', () => {
        beforeEach(() => {
          createReq = createReq.send({ expense });
        });

        describe('THEN returns 200 and expense', () => {
          var actualExpense;

          beforeEach(() => createReq
            .expect(200)
            .then(res => actualExpense = res.body));

          it('THEN returns expense data', () => {
            expect(actualExpense.title).to.be.equal(expense.title);
            expect(actualExpense.notes).to.be.equal(expense.notes);
            expect(actualExpense.category).to.be.equal(expense.category);
            expect(actualExpense.amount).to.be.equal(expense.amount);
            expect(actualExpense.currency).to.be.equal(expense.currency);
            expect(actualExpense.status).to.be.equal('PENDING');
          });

          it('THEN expense belongs to the group', () => expect(actualExpense.GroupId).to.be.equal(group.id));

          it('THEN expense belongs to the user', () => expect(actualExpense.UserId).to.be.equal(user.id));

          it('THEN a group.expense.created activity is created', () =>
            expectExpenseActivity('group.expense.created', actualExpense.id));

          describe('#delete', () => {
            describe('WHEN not authenticated', () =>
              it('THEN returns 401', () => request(app)
                .delete(`/groups/${group.id}/expenses/${actualExpense.id}`)
                .expect(401)));

            describe('WHEN expense does not belong to group', () => {
              var otherExpense;

              beforeEach(() => createOtherExpense().tap(e => otherExpense = e));

              it('THEN returns 403', () => request(app)
                .delete(`/groups/${group.id}/expenses/${otherExpense.id}`)
                .set('Authorization', `Bearer ${user.jwt(application)}`)
                .expect(403));
            });

            describe('WHEN user is not a host', () => {
              var user2;

              beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

              beforeEach(() => group.addUserWithRole(user2, roles.MEMBER));

              it('THEN returns 403', () => request(app)
                .delete(`/groups/${group.id}/expenses/${actualExpense.id}`)
                .set('Authorization', `Bearer ${user2.jwt(application)}`)
                .expect(403));
            });

            describe('success', () => {
              var response;

              beforeEach(() => request(app)
                .delete(`/groups/${group.id}/expenses/${actualExpense.id}`)
                .set('Authorization', `Bearer ${user.jwt(application)}`)
                .expect(200)
                .toPromise()
                .tap(res => response = res.body));

              it('THEN returns success:true', () => expect(response).to.have.property('success', true));

              it('THEN has deleted expense', () =>
                Expense.findById(actualExpense.id).tap(e => expect(e).to.not.exist));

              it('THEN a group.expense.deleted activity is created', () =>
                expectExpenseActivity('group.expense.deleted', actualExpense.id));
            });
          });

          describe('#approve', () => {
            var approveReq;

            beforeEach(() => {
              approveReq = request(app).post(`/groups/${group.id}/expenses/${actualExpense.id}/approve`);
            });

            describe('WHEN not authenticated', () =>
              it('THEN returns 401 unauthorized', () => approveReq.expect(401)));

            describe('WHEN authenticated as host user', () => {

              beforeEach(() => {
                approveReq = approveReq.set('Authorization', `Bearer ${user.jwt(application)}`);
              });

              describe('WHEN sending approved: false', () => {
                beforeEach(() => setExpenseApproval(false));

                it('THEN returns status: REJECTED', () => expectApprovalStatus('REJECTED'));
              });

              describe('WHEN sending approved: true', () => {

                beforeEach(() =>
                  PaymentMethod.create({
                    service: 'paypal',
                    UserId: user.id,
                    token: 'abc'
                  }));

                afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

                describe('WHEN funds are insufficient', () => {

                  beforeEach(setMaxFunds(119));

                  beforeEach(() => setExpenseApproval(true));

                  it('THEN returns 400', () =>
                    badRequest(createReq, 'Not enough funds (119 USD left) to approve transaction.'));
                });

                describe('WHEN funds are sufficient', () => {

                  beforeEach(setMaxFunds(121));

                  beforeEach(() => setExpenseApproval(true));

                  it('THEN returns status: APPROVED', () => expectApprovalStatus('APPROVED'));
                });
              });

              function setMaxFunds(maxAmount) {
                return () => {
                  preapprovalDetailsMock.maxTotalAmountOfAllPayments = maxAmount;
                  sinon
                    .stub(app.paypalAdaptive, 'preapprovalDetails')
                    .yields(null, preapprovalDetailsMock);
                };
              }

              const setExpenseApproval = approved => {
                approveReq = approveReq.send({approved});
              };

              const expectApprovalStatus = approvalStatus =>
                approveReq
                  .expect(200)
                  .then(() => Expense.findAndCountAll())
                  .tap(expenses => {
                    expect(expenses.count).to.be.equal(1);
                    expect(expenses.rows[0].status).to.be.equal(approvalStatus);
                  });
            });
          });

          describe('#pay unapproved expense', () => {
            var payReq;

            beforeEach(() => {
              payReq = request(app)
                .post(`/groups/${group.id}/expenses/${actualExpense.id}/pay`)
                .set('Authorization', `Bearer ${user.jwt(application)}`)
                .send({ payoutMethod: 'manual' });
            });

            it('THEN returns 400', () => payReq.expect(400, {
              error: {
                code: 400,
                type: 'bad_request',
                message: `Expense ${actualExpense.id} status should be APPROVED.`
              }
            }));
          });

          describe('#pay', () => {

            beforeEach(() => {
              sinon
                .stub(app.paypalAdaptive, 'preapprovalDetails')
                .yields(null, preapprovalDetailsMock);
              return request(app)
                .post(`/groups/${group.id}/expenses/${actualExpense.id}/approve`)
                .set('Authorization', `Bearer ${user.jwt(application)}`)
                .send({approved: true})
                .expect(200);
            });

            afterEach(() => app.paypalAdaptive.preapprovalDetails.restore());

            var payReq;

            beforeEach(() => {
              payReq = request(app).post(`/groups/${group.id}/expenses/${actualExpense.id}/pay`);
            });

            describe('WHEN not authenticated', () =>
              it('THEN returns 401 unauthorized', () => payReq.expect(401)));

            describe('WHEN authenticated as host user', () => {

              beforeEach(() => {
                payReq = payReq.set('Authorization', `Bearer ${user.jwt(application)}`);
              });

              var payStub;

              beforeEach(() => {
                payStub = sinon.stub(app.paypalAdaptive, 'pay', (data, cb) => {
                  return cb(null, payMock);
                });
              });

              afterEach(() => payStub.restore());

              describe('WHEN not specifying payoutMethod', () => {

                it('THEN returns 400', () => missingRequired(payReq, 'payoutMethod'));
              });

              describe('WHEN using manual payoutMethod', () => {

                beforeEach(() => {
                  payReq = payReq.send({ payoutMethod: 'manual' });
                });

                describe('THEN returns 200', () => {
                  beforeEach(() => payReq.expect(200));

                  var expense, transaction;
                  beforeEach(() => expectOne(Expense).tap(e => expense = e));
                  beforeEach(() => expectOne(Transaction).tap(t => transaction = t));

                  it('THEN does not call PayPal', () => expect(payStub.called).to.be.false);

                  it('THEN marks expense as paid', () => expect(expense.status).to.be.equal('PAID'));

                  it('THEN creates transaction', () => expectTransactionCreated(expense, transaction, 'manual'));

                  it('THEN creates a transaction paid activity', () =>
                    expectTransactionPaidActivity(group, user, transaction)
                      .tap(activity => expect(activity.data.pay).to.be.undefined));
                });
              });

              describe('WHEN specifying paypal payoutMethod', () => {

                beforeEach(() => {
                  payReq = payReq.send({payoutMethod: 'paypal'});
                });

                describe('WHEN user has no paymentMethod', () => {
                  it('returns 400', () =>
                    badRequest(payReq, 'This user has no confirmed paymentMethod linked with this service.'));
                });

                describe('WHEN user has paymentMethod', () => {
                  beforeEach(() => {
                    PaymentMethod.create({
                      service: 'paypal',
                      UserId: user.id,
                      confirmedAt: Date.now()
                    })
                  });

                  describe('THEN returns 200', () => {
                    beforeEach(() => payReq.expect(200));

                    var expense, transaction, paymentMethod;
                    beforeEach(() => expectOne(Expense).tap(e => expense = e));
                    beforeEach(() => expectOne(Transaction).tap(t => transaction = t));
                    beforeEach(() => expectOne(PaymentMethod).tap(pm => paymentMethod = pm));

                    it('THEN calls PayPal', () => expect(payStub.called).to.be.true);

                    it('THEN marks expense as paid', () => expect(expense.status).to.be.equal('PAID'));

                    it('THEN creates transaction', () => {
                      expectTransactionCreated(expense, transaction, 'paypal');
                      expect(transaction.PaymentMethodId).to.be.equal(paymentMethod.id);
                    });

                    it('THEN creates a transaction paid activity', () =>
                      expectTransactionPaidActivity(group, user, transaction)
                        .tap(activity => expect(activity.data.pay).to.deep.equal(payMock)));
                  });
                });
              });

              function expectOne(model) {
                return model.findAndCountAll()
                  .tap(entities => expect(entities.count).to.be.equal(1))
                  .then(entities => entities.rows[0]);
              }

              function expectTransactionCreated(expense, transaction, payoutMethod) {
                expect(transaction).to.have.property('netAmountInGroupCurrency', -12000);
                expect(transaction).to.have.property('ExpenseId', expense.id);
                // TODO remove #postmigration, info redundant with joined tables?
                expect(transaction).to.have.property('amount', expense.amount);
                expect(transaction).to.have.property('currency', expense.currency);
                expect(transaction).to.have.property('description', expense.title);
                expect(transaction).to.have.property('status', 'REIMBURSED');
                expect(transaction.reimbursedAt).to.be.ok;
                expect(transaction).to.have.property('UserId', expense.UserId);
                expect(transaction).to.have.property('GroupId', expense.GroupId);
                expect(transaction).to.have.property('payoutMethod', payoutMethod);
                // end TODO remove #postmigration
              }

              function expectTransactionPaidActivity(group, user, transaction) {
                return Activity
                  .findOne({ where: { type: 'group.transaction.paid' }})
                  .tap(activity => {
                    expect(activity.UserId).to.be.equal(user.id);
                    expect(activity.GroupId).to.be.equal(group.id);
                    expect(activity.TransactionId).to.be.equal(transaction.id);
                    expect(activity.data.user.id).to.be.equal(user.id);
                    expect(activity.data.group.id).to.be.equal(group.id);
                    expect(activity.data.transaction.id).to.be.equal(transaction.id);
                  });
              }
            });
          });
        });
      });
    });
  });

  function expectExpenseActivity(type, expenseId) {
    return Activity.findOne({ where: { type }})
      .then(activity => {
        expect(activity).to.be.ok;
        expect(activity.UserId).to.be.equal(user.id);
        expect(activity.GroupId).to.be.equal(group.id);
        expect(activity.data.user.id).to.be.equal(user.id);
        expect(activity.data.group.id).to.be.equal(group.id);
        expect(activity.data.expense.id).to.be.equal(expenseId);
      })
  }

  function createOtherExpense() {
    var group, user;
    return models.Group.create(utils.data('group2'))
      .tap(g => group = g)
      .then(() => models.User.create(utils.data('user2')))
      .tap(u => user = u)
      .then(() => group.addUserWithRole(user, roles.HOST))
      .then(() => request(app)
        .post(`/groups/${group.id}/expenses`)
        .set('Authorization', `Bearer ${user.jwt(application)}`)
        .send({expense})
        .expect(200))
      .then(res => res.body);
  }
});
