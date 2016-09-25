import _ from 'lodash';
import app from '../server/index';
import async from 'async';
import { expect } from 'chai';
import request from 'supertest-as-promised';
import chanceLib from 'chance';
import * as utils from '../test/utils';
import roles from '../server/constants/roles';
import sinon from 'sinon';
import emailLib from '../server/lib/email';
import stripeMock from './mocks/stripe';
import models from '../server/models';
import {appStripe} from '../server/gateways/stripe';

const chance = chanceLib.Chance();
const userData = utils.data('user1');
const userData2 = utils.data('user2');
const userData3 = utils.data('user3');
const publicGroupData = utils.data('group1');
const transactionsData = utils.data('transactions1').transactions;

describe('groups.routes.test.js', () => {

  let application;
  let user, user2, user3;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => models.User.create(userData).tap(u => user = u));

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

    beforeEach(() => models.User.create(userData2).tap(u => user2 = u));
    beforeEach(() => models.User.create(userData3).tap(u => user3 = u));

    it('fails creating a group if no api_key', () =>
      request(app)
        .post('/groups')
        .send({
          group: publicGroupData
        })
        .expect(401)
    );

    it('fails creating a group without name', (done) => {
      const group = _.omit(publicGroupData, 'name');
      group.users = [{email: userData.email, role: roles.MEMBER}];
      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group
        })
        .expect(400)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('error');
          expect(res.body.error).to.have.property('message', 'notNull Violation: name cannot be null');
          expect(res.body.error).to.have.property('type', 'validation_failed');
          expect(res.body.error).to.have.property('fields');
          expect(res.body.error.fields).to.contain('name');
          done();
        });
    });

    it('fails if the tier has missing data', () => {
      const g = Object.assign({}, publicGroupData, { users: [{email: user.email, role: roles.HOST}]});
      g.tiers = [{ // interval missing
        name: 'Silver',
        description: 'Silver',
        range: [100, 200]
      }];

      return request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: g
        })
        .expect(400, {
          error: {
            code: 400,
            type: 'validation_failed',
            message: 'Validation error: \"title\" is required',
            fields: ['tiers']
          }
        })
    });

    it('successfully create a group, while assigning the users as members', (done) => {

      const users = [
            _.assign(_.omit(userData, 'password'), {role: roles.HOST}),
            _.assign(_.omit(userData2, 'password'), {role: roles.MEMBER}),
            _.assign(_.omit(userData3, 'password'), {role: roles.MEMBER})];

      const g = Object.assign(publicGroupData, {users})

      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: g
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id');
          expect(res.body).to.have.property('name');
          expect(res.body).to.have.property('mission');
          expect(res.body).to.have.property('description');
          expect(res.body).to.have.property('longDescription');
          expect(res.body).to.have.property('logo');
          expect(res.body).to.have.property('video');
          expect(res.body).to.have.property('image');
          expect(res.body).to.have.property('backgroundImage');
          expect(res.body).to.have.property('expensePolicy');
          expect(res.body).to.have.property('createdAt');
          expect(res.body).to.have.property('updatedAt');
          expect(res.body).to.have.property('twitterHandle');
          expect(res.body).to.have.property('website');

          Promise.all([
            models.UserGroup.findOne({where: { UserId: user.id, role: roles.HOST }}),
            models.UserGroup.findOne({where: { UserId: user2.id, role: roles.MEMBER }}),
            models.UserGroup.findOne({where: { UserId: user3.id, role: roles.MEMBER }}),
            ])
          .then(results => {
            expect(results[0].GroupId).to.equal(1);
            expect(results[1].GroupId).to.equal(1);
            expect(results[2].GroupId).to.equal(1);
            done();
          })
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
        .expect(401)
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
          provider: 'github',
          secret: 'xxxxx'
        })
        .then(ca => {
          preCA = ca;
          return User.create({email: 'githubuser@gmail.com'});
        })
        .then(user => user.addConnectedAccount(preCA));
      });

      beforeEach(() => sinon.spy(emailLib, 'send'));

      afterEach(() => emailLib.send.restore());


      it('assigns contributors as users with connectedAccounts', () =>
        request(app)
        .post('/groups?flow=github')
        .set('Authorization', `Bearer ${user.jwt(application, { scope: 'connected-account', username: 'asood123', connectedAccountId: 1})}`)
        .send({
          payload: {
            group: {
              name:'Loot',
              slug:'Loot',
              expensePolicy: 'expense policy',
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
          expect(res.body).to.have.property('expensePolicy', 'expense policy');
          expect(res.body).to.have.property('isPublic', true);
          expect(emailLib.send.lastCall.args[1]).to.equal('githubuser@gmail.com');
        })
        .then(() => ConnectedAccount.findOne({where: {username: 'asood123'}}))
        .then(ca => {
          expect(ca).to.have.property('provider', 'github');
          return ca.getUser();
        })
        .then(user => expect(user).to.exist)
        .then(() => ConnectedAccount.findOne({where: {username: 'oc'}}))
        .then(ca => {
          expect(ca).to.have.property('provider', 'github');
          return ca.getUser();
        })
        .tap(user => expect(user).to.exist)
        .then(caUser => caUser.getGroups({paranoid: false})) // because we are setting deletedAt
        .tap(groups => expect(groups).to.have.length(1))
        .then(() => models.UserGroup.findAll())
        .then(userGroups => {
          expect(userGroups).to.have.length(3);
          expect(userGroups[0]).to.have.property('role', roles.MEMBER);
          expect(userGroups[1]).to.have.property('role', roles.HOST);
          expect(userGroups[2]).to.have.property('role', roles.MEMBER);
          return null;
        }))
    });

  });

  /**
   * Get.
   */
  describe('#get', () => {

    let publicGroup;

    const stubStripe = () => {
      const stub = sinon.stub(appStripe.accounts, 'create');
      const mock = stripeMock.accounts.create;
      mock.email = chance.email();
      stub.yields(null, mock);
    };

    beforeEach(() => utils.cleanAllDb().tap(a => application = a));

    beforeEach(() => {
      appStripe.accounts.create.restore();
      stubStripe();
    });

    // Create the public group with user.
    beforeEach((done) => {
      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: Object.assign(publicGroupData, { slug: 'another', users: [{ firstName: user.firstName, email: user.email, role: roles.HOST}]})
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Group
            .findById(parseInt(res.body.id))
            .tap((g) => {
              publicGroup = g;
              done();
            })
            .catch(done);
        });
    });

    beforeEach(() => models.StripeAccount
      .create({ stripePublishableKey: stripeMock.accounts.create.keys.publishable })
      .tap(account => user.setStripeAccount(account))
      .tap(account => user.setStripeAccount(account)));

    // Create another user.
    beforeEach(() => models.User.create(userData2).tap(u => user2 = u));
    beforeEach(() => models.PaymentMethod.create({UserId: user.id}))

    // Create a transaction for group1.
    beforeEach('create a transaction for group 1', () =>
      request(app)
        .post(`/groups/${publicGroup.id}/transactions`)
        .set('Authorization', `Bearer ${user.jwt(application)}`)
        .send({
          transaction: transactionsData[8]
        })
        .expect(200)
    );

    it('fails getting an undefined group', () =>
      request(app)
        .get('/groups/undefined')
        .expect(404)
    );

    it('successfully get a group if it is public', (done) => {
      request(app)
        .get(`/groups/${publicGroup.id}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicGroup.id);
          expect(res.body).to.have.property('name', publicGroup.name);
          expect(res.body).to.have.property('isPublic', true);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body).to.have.property('yearlyIncome');
          expect(res.body).to.have.property('backersCount');
          expect(res.body).to.have.property('related');
          expect(res.body.tags).to.eql(publicGroup.tags);
          expect(res.body).to.have.property('isSupercollective', false);
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
          done();
        });
    });

    it('successfully get a group by its slug (case insensitive)', (done) => {
      request(app)
        .get(`/groups/${publicGroup.slug.toUpperCase()}?api_key=${application.api_key}`)
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          expect(res.body).to.have.property('id', publicGroup.id);
          expect(res.body).to.have.property('name', publicGroup.name);
          expect(res.body).to.have.property('isPublic', true);
          expect(res.body).to.have.property('stripeAccount');
          expect(res.body.stripeAccount).to.have.property('stripePublishableKey', stripeMock.accounts.create.keys.publishable);
          done();
        });
    });

    describe('Transactions/Activities/Budget', () => {

      let group2;
      const transactions = [];
      let totTransactions = 0;
      let totDonations = 0;

      // Create group2.
      beforeEach('create group 2', () =>
        models.Group.create(_.omit(utils.data('group2'),['slug']))
          .tap(g => group2 = g)
          .then(() => group2.addUserWithRole(user, roles.HOST)));

      // Create transactions for publicGroup.
      beforeEach('create transactions for public group', (done) => {
        async.each(transactionsData, (transaction, cb) => {
          if (transaction.amount < 0)
            totTransactions += transaction.amount;
          else
            totDonations += transaction.amount;

          request(app)
            .post(`/groups/${publicGroup.id}/transactions`)
            .set('Authorization', `Bearer ${user.jwt(application)}`)
            .send({
              transaction: _.extend({}, transaction, { approved: true })
            })
            .expect(200)
            .end((e, res) => {
              expect(e).to.not.exist;
              transactions.push(res.body);
              cb();
            });
        }, done);
      });

      // Create a subscription for PublicGroup.
      beforeEach(() => models.Subscription
        .create(utils.data('subscription1'))
        .then(subscription => models.Transaction.createFromPayload({
            transaction: transactionsData[7],
            user,
            group: publicGroup,
            subscription
          })));

      it('successfully get a group with remaining budget and yearlyIncome', (done) => {
        request(app)
          .get(`/groups/${publicGroup.id}`)
          .send({
            api_key: application.api_key
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const g = res.body;
            expect(g).to.have.property('balance', parseInt((totDonations*100 + totTransactions*100 + transactionsData[7].amount*100 + transactionsData[8].amount*100).toFixed(0), 10));
            expect(g).to.have.property('yearlyIncome', (totDonations + transactionsData[7].amount * 12 + transactionsData[8].amount)*100);
            expect(g).to.not.have.property('activities');
            done();
          });
      });

      it('successfully get a group\'s users if it is public', (done) => {
        request(app)
          .get(`/groups/${publicGroup.id}/users?api_key=${application.api_key}`)
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            const userData = res.body[0];
            expect(userData.firstName).to.equal(user.public.firstName);
            expect(userData.role).to.equal(roles.HOST);
            expect(userData.tier).to.equal('host');
            done();
          });
      });

    });

    describe('Leaderboard', () => {

      it('fails if the app is not authorized', () =>
        request(app)
          .get('/leaderboard')
          .expect(401)
      );

      it('returns the leaderboard', () =>
        request(app)
          .get('/leaderboard')
          .send({
            api_key: application.api_key,
          })
          .expect(200)
      );

    });

    describe('Supercollective', () => {
      const supercollectiveData = utils.data('group4');
      supercollectiveData.users = [{email:'testuser@test.com', role: roles.MEMBER}];
      let supercollective;

      // Create supercollective
      beforeEach('create supercollective', (done) => {
        request(app)
          .post('/groups')
          .send({
            api_key: application.api_key,
            group: supercollectiveData
          })
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            models.Group
              .findById(parseInt(res.body.id))
              .tap((g) => {
                supercollective = g;
                done();
              })
              .catch(done);
          });
      });

      beforeEach('create a second group', () =>
        request(app).post('/groups')
          .send({
            api_key: application.api_key,
            group: Object.assign({}, utils.data('group2'), { users: [{email:userData3.email, role: roles.MEMBER}]})
          })
          .expect(200)
      );

      it('successfully get a supercollective with data', (done) => {
        request(app)
          .get(`/groups/${supercollective.slug.toUpperCase()}?api_key=${application.api_key}`)
          .expect(200)
          .end((e, res) => {
            expect(e).to.not.exist;
            expect(res.body).to.have.property('id', supercollective.id);
            expect(res.body).to.have.property('name', supercollective.name);
            expect(res.body).to.have.property('isSupercollective', supercollective.isSupercollective);
            expect(res.body).to.have.property('superCollectiveData')
            expect(res.body.superCollectiveData.length).to.eql(1);
            expect(res.body.superCollectiveData[0].publicUrl).to.contain('wwcode-austin');
            done();
          })
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
      whyJoin: 'because you should',
      budget: 1000000,
      burnrate: 10000,
      logo: 'http://opencollective.com/assets/logo.svg',
      video: 'http://opencollective.com/assets/video.mp4',
      image: 'http://opencollective.com/assets/image.jpg',
      backgroundImage: 'http://opencollective.com/assets/backgroundImage.png',
      expensePolicy: 'expense policy',
      isPublic: true,
      settings: { lang: 'fr' },
      otherprop: 'value'
    };

    // Create the group with user.
    beforeEach((done) => {
      request(app)
        .post('/groups')
        .send({
          api_key: application.api_key,
          group: publicGroupData
        })
        .expect(200)
        .end((e, res) => {
          expect(e).to.not.exist;
          models.Group
            .findById(parseInt(res.body.id))
            .tap((g) => {
              group = g;
              done();
            })
            .catch(done);
        });
    });

    // Create another user.
    beforeEach(() => models.User.create(utils.data('user2')).tap(u => user2 = u));

    // Create another user that is a backer.
    beforeEach(() => models.User.create(utils.data('user3'))
      .tap(u => user3 = u)
      .then(() => group.addUserWithRole(user3, roles.BACKER)));

    // Create another user that is a member.
    beforeEach(() => models.User.create(utils.data('user4'))
      .tap(u => user4 = u)
      .then(() => group.addUserWithRole(user4, roles.MEMBER)));

    it('fails updating a group if not authenticated', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .send({
          group: groupNew
        })
        .expect(401)
        .end(done);
    });

    it('fails updating a group if the user authenticated has no access', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user2.jwt(application)}`)
        .send({
          group: groupNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a group if the user authenticated is a viewer', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user3.jwt(application)}`)
        .send({
          group: groupNew
        })
        .expect(403)
        .end(done);
    });

    it('fails updating a group if no data passed', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user.jwt(application)}`)
        .expect(400)
        .end(done);
    });

    it('successfully updates a group if authenticated as a MEMBER', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user4.jwt(application)}`)
        .send({
          group: groupNew
        })
        .expect(200)
        .end(done);
    });

    it('successfully udpates a group if authenticated as a user', (done) => {
      request(app)
        .put(`/groups/${group.id}`)
        .set('Authorization', `Bearer ${user.jwt(application)}`)
        .send({
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
          expect(res.body).to.have.property('whyJoin', groupNew.whyJoin);
          expect(res.body.settings).to.have.property('lang', groupNew.settings.lang);
          expect(res.body).to.have.property('budget', groupNew.budget);
          expect(res.body).to.have.property('burnrate', groupNew.burnrate);
          expect(res.body).to.have.property('logo', groupNew.logo);
          expect(res.body).to.have.property('video', groupNew.video);
          expect(res.body).to.have.property('image', groupNew.image);
          expect(res.body).to.have.property('backgroundImage', groupNew.backgroundImage);
          expect(res.body).to.have.property('expensePolicy', groupNew.expensePolicy);
          expect(res.body).to.have.property('isPublic', groupNew.isPublic);
          expect(res.body).to.not.have.property('otherprop');
          expect(new Date(res.body.createdAt).getTime()).to.equal(new Date(group.createdAt).getTime());
          expect(new Date(res.body.updatedAt).getTime()).to.not.equal(new Date(group.updatedAt).getTime());
          done();
        });
    });

    it('successfully create a group with HOST and assign same person to be a MEMBER and a BACKER', () =>
      /* TODO: this works but we'll need to do a lot refactoring.
       * Need to find a way to call this with one line: like group.addUser()
       */
      models.UserGroup.create({
        UserId: user3.id,
        GroupId: group.id,
        role: roles.MEMBER
      })
      .then(() => models.UserGroup.findAll())
      .tap(rows => expect(rows.length).to.equal(4)));
  });

});
