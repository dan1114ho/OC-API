/**
 * Dependencies.
 */
const cheerio = require('cheerio');
const nock = require('nock');
const app = require('../index');
const async = require('async');
const jwt = require('jsonwebtoken');
const expect = require('chai').expect;
const request = require('supertest-as-promised');
const sinon = require('sinon');
const config = require('config');
const utils = require('../test/utils.js')();
const createTransaction = require('../server/controllers/transactions')(app)._create;
const stripeMock = require('./mocks/stripe');

/**
 * Variables.
 */
const STRIPE_URL = 'https://api.stripe.com:443';
var models = app.set('models');
var transactionsData = utils.data('transactions1').transactions;
var roles = require('../server/constants/roles');

/**
 * Tests.
 */
describe('subscriptions.routes.test.js', () => {
  var group;
  var user;
  var application;
  var paymentMethod;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));

  beforeEach(() => models.User.create(utils.data('user1')).tap((u => user = u)));

  beforeEach(() => models.Group.create(utils.data('group1')).tap((g => group = g)));

  beforeEach(() => group.addUserWithRole(user, roles.HOST));

  // create stripe account
  beforeEach(() => {
    models.StripeAccount.create({
      accessToken: 'sktest_123'
    })
    .then((account) => user.setStripeAccount(account));
  });

  // Create a paymentMethod.
  beforeEach(() => models.PaymentMethod.create(utils.data('paymentMethod2')).tap(c => paymentMethod = c));

  /**
   * Get the subscriptions of a user
   */
  describe('#getAll', () => {
    // Create transactions for group1.
    beforeEach((done) => {
      async.map(transactionsData, (transaction, cb) => {
        createTransaction({
          transaction,
          user,
          group,
          subscription: utils.data('subscription1')
        }, cb);
      }, done);
    });

    it('fails if the payload does not have the scope', (done) => {
      request(app)
        .get('/subscriptions')
        .set('Authorization', 'Bearer ' + user.jwt(application, {
          scope: ''
        }))
        .expect(401, {
          error: {
            code: 401,
            type: 'unauthorized',
            message: 'User does not have the scope'
          }
        })
        .end(done);
    });

    it('fails if the token expired', (done) => {
      const expiredToken = jwt.sign({
        user,
        scope: 'subscriptions'
      }, config.keys.opencollective.secret, {
        expiresIn: -1,
        subject: user.id,
        issuer: config.host.api,
        audience: application.id
      });

      request(app)
        .get('/subscriptions')
        .set('Authorization', 'Bearer ' + expiredToken)
        .end((err, res) => {
          expect(res.body.error.code).to.be.equal(401);
          expect(res.body.error.message).to.be.equal('jwt expired');
          done();
        });
    });

    it('successfully has access to the subscriptions', (done) => {
      request(app)
        .get('/subscriptions')
        .set('Authorization', 'Bearer ' + user.jwt(application, {
          scope: 'subscriptions'
        }))
        .expect(200)
        .end((err, res) => {
          expect(err).to.not.exist;
          expect(res.body.length).to.be.equal(transactionsData.length);
          res.body.forEach(sub => {
            expect(sub).to.be.have.property('stripeSubscriptionId')
            expect(sub).to.be.have.property('Transactions')
            expect(sub.Transactions[0]).to.be.have.property('Group')
          });
          done();
        });
    });
  });

  /**
   * Send a new link to the user for the subscription page
   */

  describe('#refreshTokenByEmail', () => {

    it('fails if there is no auth', (done) => {
      request(app)
        .post('/subscriptions/refresh_token')
        .expect(401, {
          error: {
            code: 401,
            message: "Missing authorization header",
            type: 'unauthorized'
          }
        })
        .end(done);
    });

    it('fails if the user does not exist', (done) => {
      const fakeUser = { id: 12312312 };
      const expiredToken = jwt.sign({ user: fakeUser }, config.keys.opencollective.secret, {
        expiresIn: 100,
        subject: fakeUser.id,
        issuer: config.host.api,
        audience: application.id
      });

      request(app)
        .post('/subscriptions/refresh_token')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(401, {
          error: {
            code: 401,
            message: "Invalid payload",
            type: 'unauthorized'
          }
        })
        .end(done);
    });

    it('sends an email with the new valid token', () => {
      const secret = config.keys.opencollective.secret;
      const expiredToken = jwt.sign({ user }, config.keys.opencollective.secret, {
        expiresIn: -1,
        subject: user.id,
        issuer: config.host.api,
        audience: application.id
      });

      return request(app)
        .post('/subscriptions/refresh_token')
        .set('Authorization', `Bearer ${expiredToken}`)
        .expect(200)
        .toPromise()
        .then(() => {
          const $ = cheerio.load(app.mailgun.sendMail.lastCall.args[0].html);
          const token = $('a').attr('href').replace('http://localhost:3000/subscriptions/', '');
          return jwt.verify(token, secret);
        });
    });

  });

  /**
   * Send a new link to the user for the subscription page
   */

  describe('#sendNewTokenByEmail', () => {

    it('fails if there is no email', (done) => {
      request(app)
        .post('/subscriptions/new_token')
        .send({
          api_key: application.api_key
        })
        .expect(400, {
          error: {
            code: 400,
            "fields": {
              "email": "Required field email missing"
            },
            message: "Missing required fields",
            type: 'missing_required'
          }
        })
        .end(done);
    });

    it('fails silently if the user does not exist', done => {
      const email = 'idonotexist@void.null';

      request(app)
        .post('/subscriptions/new_token')
        .send({
          email,
          api_key: application.api_key
        })
        .expect(200)
        .end(done);

    });

    it('sends an email to the user with the new token', () =>
      request(app)
        .post('/subscriptions/new_token')
        .send({
          email: user.email,
          api_key: application.api_key
        })
        .expect(200)
        .then(() => {
          const options = app.mailgun.sendMail.lastCall.args[0];
          const $ = cheerio.load(options.html);
          const href = $('a').attr('href');
          expect(href).to.contain(`${config.host.website}/subscriptions/`);
          expect(options.to).to.equal(user.email);
        }));
  });

  /**
   * Cancel subscription
   */
  describe('#cancel', () => {

    const subscription = utils.data('subscription1');
    var transaction;
    var nocks = {};

    beforeEach((done) => {
      createTransaction({
        transaction: transactionsData[0],
        user,
        group,
        subscription,
        paymentMethod
      }, (err, t) => {
        transaction = t;
        done(err);
      });
    });

    beforeEach(() => {
      nocks['subscriptions.delete'] = nock(STRIPE_URL)
        .delete(`/v1/customers/${paymentMethod.customerId}/subscriptions/${subscription.stripeSubscriptionId}`)
        .reply(200, stripeMock.subscriptions.create);
    });

    afterEach(() => nock.cleanAll());

    it('fails if the scope is not subscriptions', (done) => {
      request(app)
        .post(`/subscriptions/${transaction.SubscriptionId}/cancel`)
        .set('Authorization', 'Bearer ' + user.jwt(application, {
          scope: ''
        }))
        .expect(401, {
          error: {
            code: 401,
            type: 'unauthorized',
            message: 'User does not have the scope'
          }
        })
        .end(done);
    });

    it('fails if the token expired', (done) => {
      const expiredToken = jwt.sign({
        user,
        scope: 'subscriptions'
      }, config.keys.opencollective.secret, {
        expiresIn: -1,
        subject: user.id,
        issuer: config.host.api,
        audience: application.id
      });

      request(app)
        .post(`/subscriptions/${transaction.SubscriptionId}/cancel`)
        .set('Authorization', 'Bearer ' + expiredToken)
        .end((err, res) => {
          expect(res.body.error.code).to.be.equal(401);
          expect(res.body.error.message).to.be.equal('jwt expired');
          done();
        });
    });

    it('fails if the subscription does not exist', (done) => {
      request(app)
        .post('/subscriptions/12345/cancel')
        .set('Authorization', 'Bearer ' + user.jwt(application, {
          scope: 'subscriptions'
        }))
        .expect(400, {
          error: {
            code: 400,
            type: 'bad_request',
            message: 'No subscription found with id 12345'
          }
        })
        .end(done);
    });

    it('cancels the transaction', (done) => {
       request(app)
        .post(`/subscriptions/${transaction.SubscriptionId}/cancel`)
        .set('Authorization', 'Bearer ' + user.jwt(application, {
          scope: 'subscriptions'
        }))
        .expect(200)
        .end((err, res) => {
          expect(err).to.not.exist;
          expect(res.body.success).to.be.true;
          expect(nocks['subscriptions.delete'].isDone()).to.be.true;

          models.Subscription.findAll({})
            .then(subscriptions => {
              const sub = subscriptions[0];
              expect(sub.isActive).to.be.false;
              expect(sub.deactivatedAt).to.be.ok;
              done();
            })
            .catch(done);
        });
    });
  });
});
