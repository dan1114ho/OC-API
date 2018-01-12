import { expect } from 'chai';
import { describe, it } from 'mocha';
import models from '../server/models';

import * as utils from './utils';

describe('graphql.collective.test.js', () => {
  let host, collective;

  describe("read", () => {

    before(() => utils.loadDB('opencollective_dvl'));  
    before(() => models.Collective.findOne({ where: { slug: 'opensourceorg' }}).then(c => host = c));
    before(() => models.Collective.findOne({ where: { slug: 'railsgirlsatl' }}).then(c => collective = c));
    
    const query = `
    query allExpenses($CollectiveId: Int!, $limit: Int, $includeHostedCollectives: Boolean) {
      allExpenses(CollectiveId: $CollectiveId, limit: $limit, includeHostedCollectives: $includeHostedCollectives) {
        id
        description
        amount
        category
        user {
          id
          email
          paypalEmail
          collective {
            id
            slug
          }
        }
        collective {
          id
          slug
        }
      }
    }`;
    
    it('fails if collective not found', async () => {
      const result = await utils.graphqlQuery(query, { CollectiveId: 999999 });
      result.errors && console.error(result.errors);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Collective not found');
    })
    
    it('gets the latest expenses from one collective', async () => {
      const result = await utils.graphqlQuery(query, { CollectiveId: collective.id, limit: 5 });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const expenses = result.data.allExpenses;
      expect(expenses).to.have.length(5);
      expect(expenses.map(e => e.collective.slug)).to.deep.equal([ 'railsgirlsatl', 'railsgirlsatl', 'railsgirlsatl', 'railsgirlsatl', 'railsgirlsatl' ]);
    });
    
    it('gets the latest expenses from all the hosted collectives', async () => {
      const result = await utils.graphqlQuery(query, { CollectiveId: host.id, limit: 5, includeHostedCollectives: true });
      result.errors && console.error(result.errors);
      expect(result.errors).to.not.exist;
      const expenses = result.data.allExpenses;
      expect(expenses).to.have.length(5);
      expect(expenses.map(e => e.collective.slug)).to.deep.equal([ 'apex', 'opensource', 'opensource', 'opensource', 'apex' ]);
    });
  });

  describe("write", () => {
    let host, user, collective, expense;

    before(() => utils.resetTestDB());
    beforeEach(() => models.User.createUserWithCollective({ name: "Test User" }).then(u => user = u));
    beforeEach(() => models.User.createUserWithCollective({ name: "Test Host User" }).then(u => host = u));
    beforeEach(() => models.Collective.create({ name: "Test Collective", HostCollectiveId: host.CollectiveId }).then(c => collective = c));
    beforeEach(() => models.Expense.create({
      CollectiveId: collective.id,
      UserId: user.id,
      amount: 1000,
      currency: 'USD',
      description: "Test expense for pizza",
      payoutMethod: 'manual',
      incurredAt: new Date,
      lastEditedById: user.id,
      status: 'PENDING'
    }).then(e => expense = e))
    
    const createExpenseQuery = `mutation createExpense($expense: ExpenseInputType!) {
      createExpense(expense: $expense) {
        id
        status
        user {
          id
          name
          collective {
            id
            name
            slug
          }
        }
      }
    }`;

    const deleteExpenseQuery = `
    mutation deleteExpense($id: Int!) {
      deleteExpense(id: $id) {
        id
      }
    }
    `;

    const newExpenseData = {
      amount: 1000,
      currency: 'USD',
      description: "Test expense for pizza",
      payoutMethod: 'manual'
    };

    it("creates a new expense logged out", async () => {
      newExpenseData.collective = { id: collective.id };      
      const res = await utils.graphqlQuery(createExpenseQuery, { expense: newExpenseData });
      expect(res.errors).to.exist;
      expect(res.errors[0].message).to.equal('Missing expense.user.email or expense.user.paypalEmail');
      newExpenseData.user = { email: "testuser@email.com", name: "testuser" };
      const res2 = await utils.graphqlQuery(createExpenseQuery, { expense: newExpenseData });
      res2.errors && console.error(res2.errors[0]);
      expect(res2.errors).to.not.exist;
      const expense = res2.data.createExpense;
      expect(expense.status).to.equal('PENDING');
      expect(expense.user.collective.slug).to.equal("testuser");
    })

    it("creates a new expense logged in", async () => {
      newExpenseData.collective = { id: collective.id };      
      let res;
      res = await utils.graphqlQuery(createExpenseQuery, { expense: newExpenseData }, user);
      res.errors && console.error(res.errors[0].message);
      expect(res.errors).to.not.exist;
      const expense = res.data.createExpense;
      expect(expense.status).to.equal('PENDING');
      expect(expense.user.id).to.equal(user.id);
      const membership = await models.Member.findOne({ where: { CollectiveId: collective.id, role: 'CONTRIBUTOR' }});
      expect(membership).to.exist;
      expect(membership.MemberCollectiveId).to.equal(user.CollectiveId);

      // doesn't scream when adding another expense from same user
      res = await utils.graphqlQuery(createExpenseQuery, { expense: newExpenseData }, user);
      res.errors && console.error(res.errors[0].message);
      expect(res.errors).to.not.exist;
    })

    describe("delete an expense", () => {
      it("fails if not logged in", async () => {
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id });
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You need to be logged in to delete an expense");
      });

      it("fails if not logged in as author, admin or host", async () => {
        const user2 = await models.User.createUserWithCollective({ name: "test user 2"});
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id }, user2);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You don't have permission to delete this expense");
      });
      
      it("fails if logged in as backer of collective", async () => {
        const admin = await models.User.createUserWithCollective({ name: "test admin user"});
        await models.Member.create({
          CollectiveId: collective.id,
          MemberCollectiveId: admin.CollectiveId,
          role: "BACKER"
        });
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id }, admin);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You don't have permission to delete this expense");
      });

      it("works if logged in as author", async () => {
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id }, user);
        expect(res.errors).to.not.exist;
        const deletedExpense = await models.Expense.findById(expense.id);
        expect(deletedExpense).to.be.null;
      });

      it("works if logged in as admin of collective", async () => {
        const admin = await models.User.createUserWithCollective({ name: "test admin user"});
        await models.Member.create({
          CollectiveId: collective.id,
          MemberCollectiveId: admin.CollectiveId,
          role: "ADMIN"
        });
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id }, admin);
        expect(res.errors).to.not.exist;
        const deletedExpense = await models.Expense.findById(expense.id);
        expect(deletedExpense).to.be.null;
      });

      it("works if logged in as admin of host collective", async () => {
        const admin = await models.User.createUserWithCollective({ name: "test admin user"});
        await models.Member.create({
          CollectiveId: host.collective.id,
          MemberCollectiveId: admin.CollectiveId,
          role: "ADMIN"
        });
        const res = await utils.graphqlQuery(deleteExpenseQuery, { id: expense.id }, admin);
        expect(res.errors).to.not.exist;
        const deletedExpense = await models.Expense.findById(expense.id);
        expect(deletedExpense).to.be.null;
      });
    });

    describe("update status of an expense", () => {

      const approveExpenseQuery = `
        mutation approveExpense($id: Int!) {
          approveExpense(id: $id) {
            id
            status
          }
        }
      `;

      it("fails to approve expense if expense.status is PAID", async () => {
        expense.status = 'PAID';
        await expense.save();
        const res = await utils.graphqlQuery(approveExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You can't reject an expense that is already paid")
      });

      it("successfully approve expense if expense.status is PENDING", async () => {
        expense.status = 'PENDING';
        await expense.save();
        const res = await utils.graphqlQuery(approveExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.not.exist;
        expect(res.data.approveExpense.status).to.equal('APPROVED');
      });

    });

    describe("pay an expense", () => {

      const payExpenseQuery = `
        mutation payExpense($id: Int!) {
          payExpense(id: $id) {
            id
            status
          }
        }
      `;

      const addFunds = async (amount) => {
        await models.Transaction.create({
          CreatedByUserId: user.id,
          HostCollectiveId: host.CollectiveId,
          type: 'CREDIT',
          netAmountInCollectiveCurrency: amount,
          currency: 'USD',  
          CollectiveId: collective.id
        });
      }

      it("fails if expense is not approved", async () => {
        let res;
        expense.status = 'PENDING';
        await expense.save();
        res = await utils.graphqlQuery(payExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("Expense needs to be approved. Current status of the expense: PENDING.");

        expense.status = 'REJECTED';
        await expense.save();
        res = await utils.graphqlQuery(payExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("Expense needs to be approved. Current status of the expense: REJECTED.");
      });

      it("fails if not enough funds", async () => {
        // approve expense
        expense.status = 'APPROVED';
        expense.payoutMethod = 'paypal';
        await expense.save();

        // add funds to the collective
        await addFunds(500);
        const res = await utils.graphqlQuery(payExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You don't have enough funds to pay this expense. Current balance: $5, Expense amount: $10");
      });

      it("fails if not enough funds to cover the fees", async () => {
        // approve expense
        expense.status = 'APPROVED';
        expense.payoutMethod = 'paypal';
        await expense.save();

        // add funds to the collective
        await addFunds(1000);
        const res = await utils.graphqlQuery(payExpenseQuery, { id: expense.id }, host);
        expect(res.errors).to.exist;
        expect(res.errors[0].message).to.equal("You don't have enough funds to cover for the fees of this payment method. Current balance: $10, Expense amount: $10, Estimated paypal fees: $1");
      });
    })
  });
});