import {expect} from 'chai';
import app from '../index';
import request from 'supertest-as-promised';
import Promise from 'bluebird';
import sinon from 'sinon';
import emailLib from '../server/lib/email';
import _ from 'lodash';
import webhookBody from './mocks/mailgun.webhook.payload.json';

import nock from 'nock';
const MailgunNock = require('./mocks/mailgun.nock.js');

const utils = require('../test/utils.js')();
const models = app.set('models');
const Group = models.Group;
const User = models.User;

// nock.recorder.rec();

const usersData = [
  {
    name: 'Xavier Damman',
    email: 'xdamman+test@gmail.com',
    role: 'MEMBER',
    lists: ['mailinglist.members','mailinglist.info']
  },
  {
    name: 'Aseem Sood',
    email: 'asood123+test@gmail.com',
    role: 'MEMBER'
  },
  {
    name: 'Pia Mancini',
    email: 'pia+test@opencollective.com',
    role: 'BACKER',
    lists: ['mailinglist.backers']
  },
  {
    name: 'github',
    email: 'github+test@opencollective.com',
    role: 'BACKER',
    lists: ['mailinglist.backers']
  }
]

const groupData = {
  slug: 'testcollective',
  name: 'Test Collective',
  settings: {}
}

let group;

describe("email.routes.test", () => {

  let sandbox;

  before((done) => utils.cleanAllDb().tap(a => done()));

  after(() => nock.cleanAll());

  beforeEach(() => {
    sandbox = sinon.sandbox.create();
    MailgunNock();
  })

  afterEach(() => {
    nock.cleanAll()
    sandbox.restore();
  });

  before((done) => {

    Group.create(groupData)
      .tap(g => group = g )
      .then(() => User.createMany(usersData))
      .tap(users => {
        return Promise.map(users, (user, index) => {
          return group.addUserWithRole(user, usersData[index].role);
        });
      })
      .tap(users => {
        return Promise.map(users, (user, index) => {
          const lists = usersData[index].lists || [];
          return Promise.map(lists, (list) => models.Notification.create({
              channel: 'email',
              UserId: user.id,
              GroupId: group.id,
              type: list
            })
          );
        })
      })
      .then(() => done())
      .catch(e => console.error);
  });

  it("forwards emails sent to info@:slug.opencollective.com", (done) => {

    const spy = sandbox.spy(emailLib, 'sendMessage', (recipient, subject, body, opts) => {
      return Promise.resolve();
    });

    request(app)
      .post('/webhooks/mailgun')
      .send(_.defaults({recipient: 'info@testcollective.opencollective.com'}, webhookBody))
      .then(() => {
        expect(spy.args[0][0]).to.equal('info@testcollective.opencollective.com');
        expect(spy.args[0][1]).to.equal(webhookBody.subject);
        expect(spy.args[0][3].bcc).to.equal(usersData[0].email);
        done();
      });
  });
  
  it("forwards the email for approval to the core members", (done) => {

    const spy = sandbox.spy(emailLib, 'send', (template, recipient, data) => {
      return Promise.resolve();
    });

    request(app)
      .post('/webhooks/mailgun')
      .send(webhookBody)
      .then(() => {
        expect(spy.args[0][1]).to.equal('members@testcollective.opencollective.com');
        const emailSentTo = [spy.args[0][3].bcc,spy.args[1][3].bcc];
        expect(emailSentTo.indexOf(usersData[0].email) !== -1).to.be.true;
        expect(emailSentTo.indexOf(usersData[1].email) !== -1).to.be.true;
        done();
      });
  });

  it("approves the email", (done) => {

    const spy = sandbox.spy(emailLib, 'send', (template, recipient, data) => {
      console.log("emailLib.sendMessage called with ", template, recipient);
      return Promise.resolve();
    });

    request(app)
      .get(`/services/email/approve?messageId=eyJwIjpmYWxzZSwiayI6Ijc3NjFlZTBjLTc1NGQtNGIwZi05ZDlkLWU1NTgxODJkMTlkOSIsInMiOiI2NDhjZDg1ZTE1IiwiYyI6InNhb3JkIn0=&approver=${encodeURIComponent(usersData[1].email)}`)
      .then((res) => {
        expect(spy.args[0][1]).to.equal('members@testcollective.opencollective.com');
        expect(spy.args[0][2].subject).to.equal('test collective members');
        expect(spy.args[0][3].bcc).to.equal(usersData[0].email);
        expect(spy.args[0][3].from).to.equal('testcollective collective <info@testcollective.opencollective.com>');
        done();
      });
  });

  it("return 404 if message not found", (done) => {
    const messageId = 'eyJwIjpmYWxzZSwiayI6IjY5MTdlYTZlLWVhNzctNGQzOC04OGUxLWMzMTQwMzdmNGRhNiIsInMiOiIwMjNjMzgwYWFlIiwiYyI6InNhaWFkIn0=';
    request(app)
      .get(`/services/email/approve?messageId=${messageId}&approver=xdamman%40gmail.com`)
      .then((res) => {
        expect(res.statusCode).to.equal(404);
        expect(res.body.error.message).to.contain(messageId);
        done();
      });
  });

});