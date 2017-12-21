import _ from 'lodash';
import app from '../server/index';
import { expect } from 'chai';
import request from 'supertest-as-promised';
import chanceLib from 'chance';
import * as utils from '../test/utils';
import roles from '../server/constants/roles';
import sinon from 'sinon';
import emailLib from '../server/lib/email';
import stripeMock from './mocks/stripe';
import models from '../server/models';
import {appStripe} from '../server/paymentProviders/stripe/gateway';

const chance = chanceLib.Chance();

const application = utils.data('application');
const userData = utils.data('user1');
const userData2 = utils.data('user2');
const userData3 = utils.data('user3');
const publicGroupData = utils.data('collective1');
const transactionsData = utils.data('transactions1').transactions;

/**
 * We keep those old routes for backward compatibility with the old website
 * (still used for /expenses, /create, /apply)
 */
describe('groups.routes.test.js', () => {

  let host, user, sandbox;

  before(() => {
    sandbox = sinon.sandbox.create();
    utils.clearbitStubBeforeEach(sandbox);
  });

  after(() => sandbox.restore());

  beforeEach(() => utils.resetTestDB());

  beforeEach('create host', () => models.User.createUserWithCollective(utils.data('host1')).tap(u => host = u));
  beforeEach('create user', () => models.User.createUserWithCollective(userData).tap(u => user = u));

  // Stripe stub.
  beforeEach(() => {
    const stub = sinon.stub(appStripe.accounts, 'create');
    stub.yields(null, stripeMock.accounts.create);
  });
  afterEach(() => {
    appStripe.accounts.create.restore();
  });

  /**
   * Create.
   */
  describe('#create', () => {

    it('fails creating a group if no api_key', () =>
      request(app)
        .post('/groups')
        .send({
          group: publicGroupData
        })
        .expect(400)
    );

    describe('successfully create a group', () => {
      let group;

      beforeEach('subscribe host to collective.created notification', () => models.Notification.create({UserId: host.id, type: 'collective.created', channel: 'email'}));

      beforeEach('spy on emailLib', () => sinon.spy(emailLib, 'sendMessageFromActivity'));
      beforeEach('create the group', (done) => {
        const users = [
              _.assign(_.omit(userData2, 'password'), { role: roles.ADMIN }),
              _.assign(_.omit(userData3, 'password'), { role: roles.ADMIN })];

        group = Object.assign({}, publicGroupData, {users})
        group.HostId = host.id;

        request(app)
          .post('/groups')
          .send({
            api_key: application.api_key,
            group
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            group = res.body;
            done();
          })
      });

      afterEach('restore emailLib', () => emailLib.sendMessageFromActivity.restore());

      it('sends an email to the host', done => {
        setTimeout(() => {
          const activity = emailLib.sendMessageFromActivity.args[0][0];
          expect(activity.type).to.equal('collective.created');
          expect(activity.data).to.have.property('collective');
          expect(activity.data).to.have.property('host');
          expect(activity.data).to.have.property('user');
          expect(emailLib.sendMessageFromActivity.args[0][1].User.email).to.equal(host.email);
          done();
        }, 200);

      });

      it('returns the attributes of the group', () => {
        expect(group).to.have.property('id');
        expect(group).to.have.property('name');
        expect(group).to.have.property('mission');
        expect(group).to.have.property('description');
        expect(group).to.have.property('longDescription');
        expect(group).to.have.property('image');
        expect(group).to.have.property('backgroundImage');
        expect(group).to.have.property('createdAt');
        expect(group).to.have.property('updatedAt');
        expect(group).to.have.property('twitterHandle');
        expect(group).to.have.property('website');
        expect(group).to.have.property('isActive', true);
      });

      it('assigns the users as members', () => {
        return Promise.all([
          models.Member.findOne({ where: { MemberCollectiveId: host.CollectiveId, role: roles.HOST } }),
          models.Member.count({ where: { CollectiveId: group.id, role: roles.ADMIN } }),
          models.Collective.find({ where: { slug: group.slug } })
          ])
        .then(results => {
          expect(results[0].CollectiveId).to.equal(group.id);
          expect(results[1]).to.equal(2);
          expect(results[2].LastEditedByUserId).to.equal(3);
        });
      });

    });

  });

  /**
   * Create from Github
   */
  describe('#createFromGithub', () => {

    it('fails creating a group if param value is not github', () =>
      request(app)
        .post('/groups?flow=blah')
        .send({
          payload: publicGroupData
        })
        .expect(400)
    );

    it('fails creating a group if no api key', () =>
      request(app)
        .post('/groups?flow=github')
        .send({
          payload: publicGroupData
        })
        .expect(400)
    );

    it('fails creating a group without payload', () =>
      request(app)
        .post('/groups?flow=github')
        .send({
          group: publicGroupData,
          api_key: application.api_key
        })
        .expect(400)
    );

    describe('Successfully create a group and ', () => {

      const { ConnectedAccount } = models;

      beforeEach(() => {
        const { User } = models;

        // create connected account like the oauth happened
        let preCA;
        return ConnectedAccount.create({
          username: 'asood123',
          service: 'github',
          secret: 'xxxxx'
        })
        .then(ca => {
          preCA = ca;
          return User.createUserWithCollective({email: 'githubuser@gmail.com'});
        })
        .then(user => user.collective.addConnectedAccount(preCA));
      });

      beforeEach(() => sinon.spy(emailLib, 'send'));

      afterEach(() => emailLib.send.restore());

      it('assigns contributors as users with connectedAccounts', () =>
        request(app)
        .post('/groups?flow=github')
        .set('Authorization', `Bearer ${user.jwt({ scope: 'connected-account', username: 'asood123', connectedAccountId: 1 })}`)
        .send({
          payload: {
            group: {
              name:'Loot',
              slug:'Loot',
              mission: 'mission statement'
            },
            users: ['asood123', 'oc'],
            github_username: 'asood123'
          },
          api_key: application.api_key
        })
        .expect(200)
        .toPromise()
        .tap(res => {
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name', 'Loot');
          expect(res.body).to.have.property('slug', 'loot');
          expect(res.body).to.have.property('mission', 'mission statement');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('isActive', true);
          expect(emailLib.send.lastCall.args[1]).to.equal('githubuser@gmail.com');
        })
        .then(() => ConnectedAccount.findOne({where: { username: 'asood123' }}))
        .then(ca => {
          expect(ca).to.have.property('service', 'github');
          return ca.getCollective();
        })
        .then(userCollective => expect(userCollective).to.exist)
        .then(() => models.Member.findAll())
        .then(Members => {
          expect(Members).to.have.length(2);
          expect(Members[0]).to.have.property('role', roles.ADMIN);
          expect(Members[1]).to.have.property('role', roles.HOST);
          return null;
        }))
    });

  });

  /**
   * Get.
   */
  describe('#get', () => {

    let publicCollective;

    const stubStripe = () => {
      const stub = sinon.stub(appStripe.accounts, 'create');
      const mock = stripeMock.accounts.create;
      mock.email = chance.email();
      stub.yields(null, mock);
    };

    // beforeEach(() => utils.resetTestDB());

    beforeEach(() => {
      appStripe.accounts.create.restore();
      stubStripe();
    });

    // Create the public group with user.
    beforeEach('create public group with host', (done) => {
      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: Object.assign({}, publicGroupData, { isActive: true, slug: 'another', HostId: host.id, users: [ Object.assign({}, userData, { role: roles.ADMIN} )]})
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Collective
            .findById(parseInt(res.body.id))
            .then((g) => {
              publicCollective = g;
              done();
            })
            .catch(done);
        });
    });

    const stripeAccount = { data: { publishableKey: stripeMock.accounts.create.keys.publishable } };
    beforeEach(() => host.collective
      .setStripeAccount(stripeAccount)
      .then(() => user.collective.setStripeAccount(stripeAccount)));

    beforeEach('create a new payment method for user', () => models.PaymentMethod.create({
      CollectiveId: user.CollectiveId,
      service: 'stripe',
      type: 'creditcard',
      token: 'tok_123456781234567812345678'
    }))

    // Create a transaction for group1.
    beforeEach('create a transaction for group 1', () =>
      models.Transaction.create({
        ...transactionsData[8],
        netAmountInCollectiveCurrency: transactionsData[8].amount,
        CreatedByUserId: user.id,
        FromCollectiveId: user.CollectiveId,
        CollectiveId: publicCollective.id,
        HostCollectiveId: host.CollectiveId
      }));

    beforeEach('add user as backer', () => models.Member.create({
      role: roles.BACKER,
      MemberCollectiveId: user.CollectiveId,
      CollectiveId: publicCollective.id
    }));

    it('fails getting an undefined group', () =>
      request(app)
        .get(`/groups/undefined?api_key=${application.api_key}`)
        .expect(404)
    );

    it('successfully get a group', (done) => {
      request(app)
        .get(`/groups/${publicCollective.id}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicCollective.id);
          expect(res.body).to.have.property('name', publicCollective.name);
          expect(res.body).to.have.property('isActive', true);
          expect(res.body).to.have.property('yearlyIncome');
          expect(res.body).to.have.property('backersCount');
          expect(res.body).to.have.property('related');
          expect(res.body.tags).to.eql(publicCollective.tags);
          expect(res.body).to.have.property('isSupercollective', false);
          done();
        });
    });

    it('successfully get a group by its slug (case insensitive)', (done) => {
      request(app)
        .get(`/groups/${publicCollective.slug.toUpperCase()}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicCollective.id);
          expect(res.body).to.have.property('name', publicCollective.name);
          expect(res.body).to.have.property('isActive', true);
          done();
        });
    });

    describe('Transactions/Budget', () => {

      let totTransactions = 0;
      let totDonations = 0;

      const transactions = transactionsData.map(transaction => {
        if (transaction.amount < 0)
          totTransactions += transaction.amount;
        else
          totDonations += transaction.amount;

        transaction.netAmountInCollectiveCurrency = transaction.amount;
        return transaction;
      });

      // Create group2
      beforeEach('create group 2', () =>
        models.Collective.create({HostCollectiveId: host.CollectiveId, name: "group 2", slug: "group2"})
      );

        // Create transactions for publicCollective.
      beforeEach('create transactions for public group', () => models.Transaction
        .createMany(transactions, {
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: publicCollective.id,
          HostCollectiveId: host.CollectiveId,
          approved: true
        })
      );

      // Create a subscription for PublicCollective.
      beforeEach(() => models.Subscription
        .create(utils.data('subscription1'))
        .then(subscription => models.Order.create({
          amount: 999,
          currency: 'USD',
          CreatedByUserId: user.id,
          FromCollectiveId: user.CollectiveId,
          CollectiveId: publicCollective.id,
          SubscriptionId: subscription.id
        }))
        .then(order => models.Transaction.createFromPayload({
            transaction: Object.assign({}, transactionsData[7], { netAmountInCollectiveCurrency: transactionsData[7].amount, OrderId: order.id}),
            CreatedByUserId: user.id,
            FromCollectiveId: user.CollectiveId,
            CollectiveId: publicCollective.id,
          })));

      it('successfully get a group with remaining budget and yearlyIncome', (done) => {
        request(app)
          .get(`/groups/${publicCollective.id}`)
          .send({
            api_key: application.api_key
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const g = res.body;
            expect(g).to.have.property('balance', parseInt((totDonations + totTransactions + transactionsData[7].amount + transactionsData[8].amount).toFixed(0), 10));
            expect(g).to.have.property('yearlyIncome', (transactionsData[7].amount + transactionsData[7].amount * 12)); // one is a single payment and other is a subscription
            done();
          });
      });

      it('successfully get a group\'s backers', (done) => {
        request(app)
          .get(`/groups/${publicCollective.id}/backers?api_key=${application.api_key}`)
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const userData = res.body[0];
            expect(userData.firstName).to.equal(user.public.firstName);
            expect(userData.lastName).to.equal(user.public.lastName);
            expect(userData.name).to.equal(`${user.public.firstName} ${user.public.lastName}`);
            expect(userData.role).to.equal(roles.BACKER);
            done();
          });
      });

    });

  });

  /**
   * Update.
   */
  describe('#update', () => {

    let group;
    let user2;
    let user3;
    let user4;
    const groupNew = {
      name: 'new name',
      mission: 'new mission',
      description: 'new desc',
      longDescription: 'long description',
      budget: 1000000,
      burnrate: 10000,
      image: 'http://opengroup.com/assets/image.svg',
      backgroundImage: 'http://opengroup.com/assets/backgroundImage.png',
      isActive: true,
      settings: { lang: 'fr' },
      otherprop: 'value'
    };

    // Create the group with user.
    beforeEach('create public group with host', (done) => {
      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: Object.assign({}, publicGroupData, {
            slug: 'public-group',
            name: 'public group with host',
            HostCollectiveId: host.CollectiveId,
            users: [ Object.assign({}, userData, { role: roles.ADMIN} ) ]
          })
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Collective
            .findById(parseInt(res.body.id))
            .then((g) => {
              group = g;
              done();
            })
            .catch(done);
        });
    });

    // Create another user.
    beforeEach(() => models.User.createUserWithCollective(utils.data('user2')).then(u => user2 = u));

    // Create another user that is a backer.
    beforeEach(() => models.User.createUserWithCollective(utils.data('user3'))
      .tap(u => user3 = u)
      .then(() => group.addUserWithRole(user3, roles.BACKER)));

    // Create another user that is a member.
    beforeEach(() => models.User.createUserWithCollective(utils.data('user4'))
      .tap(u => user4 = u)
      .then(() => group.addUserWithRole(user4, roles.ADMIN)));

    it('fails updating a group if not authenticated', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .send({
          api_key: application.api_key,
          group: groupNew
        })
        .expect(401)
        .end(done);
    });

    it('fails updating a group if the user authenticated has no access', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user2.jwt()}`)
        .send({
          api_key: application.api_key,
          group: groupNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a group if the user authenticated is a viewer', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user3.jwt()}`)
        .send({
          api_key: application.api_key,
          group: groupNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a group if no data passed', (done) => {
      request(app)
        .put(`/groups/${group.id}?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .expect(400)
        .end(done);
    });

    it('successfully updates a group if authenticated as a ADMIN', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user4.jwt()}`)
        .send({
          api_key: application.api_key,
          group: groupNew
        })
        .expect(200)
        .end(done);
    });

    it('successfully udpates a group if authenticated as a user', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .send({
          api_key: application.api_key,
          group: groupNew
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', group.id);
          expect(res.body).to.have.property('name', groupNew.name);
          expect(res.body).to.have.property('mission', groupNew.mission);
          expect(res.body).to.have.property('description', groupNew.description);
          expect(res.body).to.have.property('longDescription', groupNew.longDescription);
          expect(res.body.settings).to.have.property('lang', groupNew.settings.lang);
          expect(res.body).to.have.property('image', groupNew.image);
          expect(res.body).to.have.property('backgroundImage', groupNew.backgroundImage);
          expect(res.body).to.have.property('isActive', groupNew.isActive);
          expect(res.body).to.not.have.property('otherprop');
          expect(new Date(res.body.createdAt).getTime()).to.equal(new Date(group.createdAt).getTime());
          expect(new Date(res.body.updatedAt).getTime()).to.not.equal(new Date(group.updatedAt).getTime());
          done();
        });
    });

    it('successfully create a group with HOST and assign same person to be a ADMIN and a BACKER', () =>
      /* TODO: this works but we'll need to do a lot refactoring.
       * Need to find a way to call this with one line: like group.addUser()
       */
      models.Member.create({
        MemberCollectiveId: user3.CollectiveId,
        CollectiveId: group.id,
        role: roles.ADMIN
      })
      .then(() => models.Member.findAll({ where: { MemberCollectiveId: user3.CollectiveId, CollectiveId: group.id }}))
      .tap(rows => expect(rows.length).to.equal(2)));
  });

});