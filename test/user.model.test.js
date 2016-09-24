import {expect} from 'chai';
import * as utils from '../test/utils';
import models from '../server/models';

const userData = utils.data('user1');

const { User, Group, Transaction } = models;

describe('user.models.test.js', () => {

  beforeEach(() => utils.cleanAllDb());

  /**
   * Create a user.
   */
  describe('#create', () => {

    it('succeeds without email', () =>
      User
        .create({ firstName: userData.firstName})
        .tap(user => expect(user).to.have.property('firstName', userData.firstName)));

    it('fails if invalid email', () =>
      User
        .create({ firstName: userData.firstName, email: 'johndoe'})
        .catch(err => expect(err).to.exist));

    it('successfully creates a user and lowercase email', () =>
      User
        .create({ firstName: userData.firstName, email: userData.email})
        .tap(user => {
          expect(user).to.have.property('firstName', userData.firstName);
          expect(user).to.have.property('email', userData.email.toLowerCase());
          expect(user).to.have.property('createdAt');
          expect(user).to.have.property('updatedAt');
        }));


    it('successfully creates a user with a password that is a number', () => {
      const email = 'john.doe@doe.com';

      return User
        .create({
          email,
          password: 123456
        })
        .tap(user => {
          expect(user).to.have.property('email', email);
          expect(user).to.have.property('createdAt');
          expect(user).to.have.property('password_hash');
          expect(user).to.have.property('updatedAt');
        });
    });

    it('successfully creates a user with a password that is a string', () => {
      const email = 'john.doe@doe.com';

      return User
        .create({
          email,
          password: '123456'
        })
        .tap(user => {
          expect(user).to.have.property('email', email);
          expect(user).to.have.property('createdAt');
          expect(user).to.have.property('password_hash');
          expect(user).to.have.property('updatedAt');
        });
    });

    it('creates a unique username', () => {
      return User
        .create({username: 'xdamman'})
        .tap(user => {
          expect(user.username).to.equal('xdamman')
        })
        .then(() => User.create({ email: 'xdamman@gmail.com'}))
        .then(user => {
          expect(user.username).to.equal('xdamman1')
        })
        .then(() => User.create({ twitterHandle: 'xdamman'}))
        .then(user => {
          expect(user.username).to.equal('xdamman2')
        })
        .then(() => User.create({ firstName: 'Xavier', lastName: 'Damman'}))
        .then(user => {
          expect(user.username).to.equal('xavierdamman')
        })
    })

  });

  /**
   * Get a user.
   */
  describe('#get', () => {

    beforeEach(() => User.create(userData));

    it('successfully get a user, user.info and user.public return correct information', (done) => {
      User.findOne({}).then((user) => {
        expect(user.info).to.have.property('email');
        expect(user.info).to.have.property('paypalEmail');
        expect(user.public).to.not.have.property('email');
        expect(user.public).to.not.have.property('paypalEmail');
        expect(user.public).to.have.property('website');
        expect(user.public).to.have.property('twitterHandle');
        expect(user.public.twitterHandle).to.equal(userData.twitterHandle);
        expect(userData.website).to.be.undefined;
        expect(user.website).to.equal(`https://twitter.com/${userData.twitterHandle}`);
        done();
      });
    });

  });

  describe('class methods', () => {

    const users = [ utils.data('user1'), utils.data('user2') ];
    const transactions = [{
      createdAt: new Date('2016-06-14'),
      amount: 100,
      netAmountInGroupCurrency: 10000,
      currency: 'USD',
      type: 'donation',
      UserId: 1,
      GroupId: 1
    },{
      createdAt: new Date('2016-06-15'),
      amount: 150,
      netAmountInGroupCurrency: 15000,
      currency: 'USD',
      type: 'donation',
      UserId: 1,
      GroupId: 2
    },{
      createdAt: new Date('2016-07-15'),
      amount: 250,
      netAmountInGroupCurrency: 25000,
      currency: 'USD',
      type: 'donation',
      UserId: 2,
      GroupId: 1
    },{
      createdAt: new Date('2016-07-16'),
      amount: 500,
      netAmountInGroupCurrency: 50000,
      currency: 'USD',
      type: 'donation',
      UserId: 2,
      GroupId: 2
    }];

    beforeEach(() => utils.cleanAllDb());
    beforeEach(() => User.createMany(users));
    beforeEach(() => Group.create(utils.data('group1')));
    beforeEach(() => Group.create(utils.data('group2')));
    beforeEach(() => Transaction.createMany(transactions));

    it('gets the top backers', () => {
      return User.getTopBackers()
        .then(backers => {
          backers = backers.map(g => g.dataValues);
          expect(backers.length).to.equal(2);
          expect(backers[0].totalDonations).to.equal(750);
          expect(backers[0]).to.have.property('firstName');
          expect(backers[0]).to.have.property('avatar');
          expect(backers[0]).to.have.property('website');
          expect(backers[0]).to.have.property('twitterHandle');
        });
    });

    it('gets the top backers in a given month', () => {
      return User.getTopBackers(new Date('2016-06-01'), new Date('2016-07-01'))
        .then(backers => {
          backers = backers.map(g => g.dataValues);
          expect(backers.length).to.equal(1);
          expect(backers[0].totalDonations).to.equal(250);
        });
    });

    it('gets the top backers in open source', () => {
      return User.getTopBackers(new Date('2016-06-01'), new Date('2016-07-01'), ['open source'])
        .then(backers => {
          backers = backers.map(g => g.dataValues);
          expect(backers.length).to.equal(1);
          expect(backers[0].totalDonations).to.equal(100);
        });
    });

    it('gets the latest donations of a user', () => {
      return User.findOne().then(user => {
        return user.getLatestDonations(new Date('2016-06-01'), new Date('2016-08-01'))
          .then(donations => {
            expect(donations.length).to.equal(2);
          })
      });
    });

    it('gets the latest donations of a user to open source', () => {
      return User.findOne().then(user => {
        return user.getLatestDonations(new Date('2016-06-01'), new Date('2016-08-01'), ['open source'])
          .then(donations => {
            expect(donations.length).to.equal(1);
            expect(donations[0]).to.have.property("amount");
            expect(donations[0]).to.have.property("currency");
            expect(donations[0]).to.have.property("Group");
            expect(donations[0].Group).to.have.property("name");
          })
      });
    });

  });

});
