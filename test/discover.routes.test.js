/**
 * Dependencies.
 */
var app = require('../index');
var expect = require('chai').expect;
var request = require('supertest-as-promised');
var utils = require('../test/utils.js')();

/**
 * Variables.
 */
var groupData1 = utils.data('group1'); // `open source` tag
var groupData2 = utils.data('group2'); // `meetup` tag
var paymentMethodData1 = utils.data('paymentMethod1');
var transactionsData = utils.data('transactions1').transactions;
var models = app.set('models');

/**
 * Tests.
 */
describe('profile.routes.test.js', () => {

  var application;
  var group1, group2, paymentMethod1;

  beforeEach(() => utils.cleanAllDb().tap(a => application = a));
  beforeEach(() => models.PaymentMethod.create(paymentMethodData1).tap(pm => paymentMethod1 = pm));
  beforeEach(() => models.Group.create(groupData1).tap(g => group1 = g));
  beforeEach(() => models.Group.create(groupData2).tap(g => group2 = g));
  beforeEach((done) => {
    transactionsData[8].GroupId = group1.id;
    transactionsData[8].PaymentMethodId = paymentMethod1.id;
    models.Transaction.create(transactionsData[8]).tap(() => done()).catch(done);
  });
  beforeEach((done) => {
    transactionsData[8].GroupId = group2.id;
    transactionsData[8].PaymentMethodId = paymentMethod1.id;
    models.Transaction.create(transactionsData[8]).tap(() => done()).catch(done);
  });

  /**
   * Get.
   */
  describe('#get /discover', () => {

    it('/discover - No params defaults to: /discover?show=all&sort=newest', (done) => {
      request(app)
        .get('/discover')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('all');
          expect(body.sort).equal('newest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(2);
          expect(ids.indexOf(group1.id)).not.equal(-1);
          expect(ids.indexOf(group2.id)).not.equal(-1);
          expect(ids[0]).equal(group2.id); // Newest (created second)
          expect(ids[1]).equal(group1.id);
          done();
        })
    });

    it('/discover?show=open source', (done) => {
      request(app)
        .get('/discover?show=open source')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('open source');
          expect(body.sort).equal('newest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(1);
          expect(ids.indexOf(group1.id)).not.equal(-1);
          expect(ids.indexOf(group2.id)).equal(-1);
          expect(ids[0]).equal(group1.id);
          done();
        })
    });

    it('/discover?show=meetup', (done) => {
      request(app)
        .get('/discover?show=meetup')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('meetup');
          expect(body.sort).equal('newest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(1);
          expect(ids.indexOf(group1.id)).equal(-1);
          expect(ids.indexOf(group2.id)).not.equal(-1);
          expect(ids[0]).equal(group2.id);
          done();
        })
    });

    it('/discover?show=undefined', (done) => {
      request(app)
        .get('/discover?show=undefined')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('undefined');
          expect(body.sort).equal('newest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(0);
          done();
        })
    });

    it('/discover?show=all&sort=oldest', (done) => {
      request(app)
        .get('/discover?show=all&sort=oldest')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('all');
          expect(body.sort).equal('oldest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(2);
          expect(ids.indexOf(group1.id)).not.equal(-1);
          expect(ids.indexOf(group2.id)).not.equal(-1);
          expect(ids[0]).equal(group1.id); // Oldest (created first)
          expect(ids[1]).equal(group2.id);
          done();
        })
    });

    it('/discover?show=all&sort=undefined', (done) => {
      request(app)
        .get('/discover?show=all&sort=undefined')
        .expect(200)
        .end((err, res) => {
          const body = res.body;
          const ids = body.collectives.map(c => c.id);
          expect(body.show).equal('all');
          expect(body.sort).equal('newest');
          expect(body.collectives).to.be.Array;
          expect(body.collectives.length).equal(2);
          expect(ids.indexOf(group1.id)).not.equal(-1);
          expect(ids.indexOf(group2.id)).not.equal(-1);
          expect(ids[0]).equal(group2.id); // Newest (created second)
          expect(ids[1]).equal(group1.id);
          done();
        })
    });

  });
});
