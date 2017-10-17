/**
 * Dependencies.
 */
import _ from 'lodash';
import async from 'async';
import { defaultHostUser, getLinkHeader, getRequestedUrl } from '../lib/utils';
import Promise from 'bluebird';
import roles from '../constants/roles';
import activities from '../constants/activities';
import emailLib from '../lib/email';
import fetchGithubUser from '../lib/github';
import queries from '../lib/queries';
import models from '../models';
import errors from '../lib/errors';
import debugLib from 'debug';
import config from 'config';

const {
  Activity,
  Notification,
  Collective,
  ConnectedAccount,
  User
} = models;

const _addUserToCollective = (collective, user, options) => {
  const checkIfCollectiveHasHost = () => {
    if (options.role !== roles.HOST) {
      return Promise.resolve();
    }

    return models.Member.findOne({
      where: {
        CollectiveId: collective.id,
        role: roles.HOST
      }
    })
    .then(host => {
      if (host) {
        return Promise.reject(new errors.BadRequest('Collective already has a host'));
      }
      return Promise.resolve();
    })
  };

  const addUserToCollective = () => collective.addUserWithRole(user, options.role);

  const createActivity = () => Activity.create({
    type: 'collective.user.added',
    CollectiveId: collective.id,
    data: {
      collective: collective.info,
      creator: options.remoteUser.info,
      user: user.info,
      role: options.role
    }
  });

  return checkIfCollectiveHasHost()
    .then(addUserToCollective)
    .then(createActivity);
};

const _getUsersData = (collective, tier) => {
  return collective.getSuperCollectiveCollectivesIds()
    .then(ids => {
      if (tier === 'backers') {
        return queries.getBackersOfCollectiveWithTotalDonations(ids).then(backerCollectives => models.Tier.appendTier(collective, backerCollectives))
      } else {
        return queries.getMembersOfCollectiveWithRole(ids).then(backerCollectives => models.Tier.appendTier(collective, backerCollectives));
      }
    });
};

export const getUsers = (req, res, next) => {
  let promise = _getUsersData(req.collective, req.params.tierSlug);

  if (req.query.filter && req.query.filter === 'active') {
    const activeUsersByCollectiveId = {};
    promise = promise.then(userCollectives => {
      const UserCollectiveIds = userCollectives.map(u => u.id);
      return models.Order.findAll({
        where: { FromCollectiveId: { $in: UserCollectiveIds}},
        include: [
          { model: models.Subscription, where: { isActive: true } }
        ]
      }).then(orders => {
        orders.map(o => {
          activeUsersByCollectiveId[o.FromCollectiveId] = Boolean(o.Subscription && o.Subscription.isActive);
        })
        return userCollectives.filter(u => activeUsersByCollectiveId[u.id]);
      })
    });
  }

  return promise
    .map(userCollective => {
      let avatar = userCollective.image;
      if (avatar && avatar.match(/^\//)) {
        avatar = `${config.host.website}${avatar}`
      }
      const u = {
        ...userCollective.dataValues,
        tier: userCollective.tier && userCollective.tier.slug,
        avatar
      };
      delete u.image;
      if (!u.tier) {
        u.tier = (u.type === 'USER') ? 'backer' : 'sponsor';
      }
      if (!req.collective || !req.remoteUser || !req.remoteUser.isAdmin(req.collective.id)) {
        delete u.email;
      }
      return u;
    })
    .then(users => res.send(users))
    .catch(next)
};

/**
 * Delete a transaction.
 */
export const deleteTransaction = (req, res, next) => {
   const { transaction } = req;
   const { collective } = req;
   const user = req.remoteUser || {};

   async.auto({

     deleteTransaction: (cb) => {
       transaction
         .destroy()
         .then(() => cb())
         .catch(cb);
     },

     createActivity: ['deleteTransaction', (cb) => {
       Activity.create({
         type: 'collective.transaction.deleted',
         UserId: user.id,
         CollectiveId: collective.id,
         data: {
           collective: collective.info,
           transaction,
           user: user.info
         }
       })
       .then(activity => cb(null, activity))
       .catch(cb);
     }]

   }, (e) => {
     if (e) return next(e);
     res.send({success: true});
   });
};

/**
 * Create a collective.
 */
export const create = (req, res, next) => {
  const collectiveData = req.required.group;
  const { users = [] } = collectiveData;
  let createdCollective, creator, host;

  if (users.length < 1) throw new errors.ValidationFailed('Need at least one user to create a collective');

  const sendConfirmationEmail = (user, collective) => {
    const data = {
      collective,
      confirmation_url: user.generateLoginLink(`/${collective.slug}`)
    }
    emailLib.send('collective.confirm', user.email, data);
  };

  collectiveData.tiers = [
    {
      type: 'TIER',
      name: 'backer',
      slug: 'backers',
      amount: 500,
      interval: 'month'
    },
    {
      type: 'TIER',
      name: 'sponsor',
      slug: 'sponsors',
      amount: 10000,
      interval: 'month'
    }
  ];

  return Collective
    .create(collectiveData)
    .tap(g => createdCollective = g)
    .tap(g => {
      return Promise.each(users, user => {
        if (user.email) {
          return User.findOne({ where: { email: user.email.toLowerCase() }})
          .then(u => u || User.createUserWithCollective(user))
          .then(u => {
            if (!creator) {
              creator = u;
            }
            if (user.role === roles.HOST && !collectiveData.HostId) {
              collectiveData.HostId = u.id;
              return;
            }
            return _addUserToCollective(g, u, { role: user.role, remoteUser: creator })
          })
          .then(() => createdCollective.update({ CreatedByUserId: creator.id, LastEditedByUserId: creator.id }))
        } else {
          return null;
        }
      })
    })
    .tap(collective => {
      return models.User.findOne({ where: { id: collectiveData.HostId || defaultHostUser().id }}).tap(h => {
        host = h;
        collective.HostCollectiveId = h.CollectiveId;
        if (collectiveData.HostId) {
          models.Collective.findById(h.CollectiveId).then(host => {
            collective.currency = host.currency;
            collective.save();
          })
        } else {
          collective.save();
        }
        _addUserToCollective(collective, h, { role: roles.HOST, remoteUser: creator })
        return null;
      })
    })
    .then(() => {
      if (collectiveData.tiers) {
        return models.Tier.createMany(collectiveData.tiers, { CollectiveId: createdCollective.id, currency: collectiveData.currency })
      }
      return null;
    })
    .then(() => Activity.create({
      type: activities.COLLECTIVE_CREATED,
      UserId: creator.id,
      CollectiveId: createdCollective.id,
      data: {
        collective: createdCollective.info,
        host: host && host.info,
        user: creator.info
      }
    }))
    .then(() => sendConfirmationEmail(creator, createdCollective))
    .then(() => res.send(createdCollective.info))
    .catch(next);
};

/*
 * Creates a collective from Github
 */
export const createFromGithub = (req, res, next) => {

  const { payload } = req.required;
  const { connectedAccountId } = req.jwtPayload;
  const debug = debugLib("github");
  let creatorUser, creatorCollective, options, creatorCollectiveConnectedAccount;
  const collectiveData = payload.group;
  const githubUser = payload.user;
  const contributors = payload.users;
  const creatorGithubUsername = payload.github_username;
  let createdCollective;
  
  collectiveData.tiers = [
    {
      type: 'TIER',
      name: 'backer',
      slug: 'backers',
      amount: 500,
      interval: 'month'
    },
    {
      type: 'TIER',
      name: 'sponsor',
      slug: 'sponsors',
      amount: 10000,
      interval: 'month'
    }
  ];

  // Find the creator's Connected Account
  ConnectedAccount
    .findOne({
      where: { id: connectedAccountId },
      include: { model: Collective }
    })
    .then(ca => {
      debug("connected account found", ca && ca.username);
      creatorCollective = ca.Collective;
      creatorCollectiveConnectedAccount = ca;
      return models.User.findById(creatorCollective.CreatedByUserId);
    })
    .then(user => {
      creatorUser = user;
      options = {
        role: roles.ADMIN,
        remoteUser: creatorUser
      };
      debug("creatorUser", user && user.dataValues);
    })
    .tap(() => {
      if (githubUser) {
        if (githubUser.name) {
          const nameTokens = githubUser.name.split(' ');
          creatorUser.firstName = nameTokens.shift();
          creatorUser.lastName = nameTokens.join(' ');
          creatorUser.save();
        }
        creatorCollective.website = githubUser.blog;
        return creatorCollective.save();
      }
    })
    .then(() => Collective.findOne({ where: { slug: collectiveData.slug.toLowerCase() }}))
    .then(existingCollective => {
      if (existingCollective) {
        collectiveData.slug = `${collectiveData.slug}-${Math.floor((Math.random() * 1000) + 1)}`;
      }
      return Collective.create(Object.assign({}, collectiveData, { CreatedByUserId: creatorUser.id, LastEditedByUserId: creatorUser.id, HostCollectiveId: defaultHostUser('opensource').CollectiveId }));
    })
    .tap(g => debug("createdCollective", g && g.dataValues))
    .tap(g => createdCollective = g)
    .then(() => _addUserToCollective(createdCollective, creatorUser, options))
    .then(() => _addUserToCollective(createdCollective, defaultHostUser("opensource"), { role: roles.HOST, remoteUser: creatorUser }))
    .then(() => {
      if (collectiveData.tiers) {
        return models.Tier.createMany(collectiveData.tiers, { CollectiveId: createdCollective.id, currency: collectiveData.currency })
      }
      return null;
    })
    .tap((host) => Activity.create({
      type: activities.COLLECTIVE_CREATED,
      UserId: creatorUser.id,
      CollectiveId: createdCollective.id,
      data: {
        collective: createdCollective.info,
        host: host.info,
        user: creatorUser.info
      }
    }))
    .then(() => Promise.map(contributors, contributor => {
    // since we added the creator above with an email, avoid double adding
    if (contributor !== creatorGithubUsername && contributor !== creatorCollectiveConnectedAccount.username) {
      const caAttr = {
        username: contributor,
        service: 'github'
      };
      const userAttr = {
        image: `https://images.githubusercontent.com/${contributor}`
      };
      let connectedAccount, contributorUserCollective;
      return ConnectedAccount.findOne({ where: caAttr })
        .then(ca => {
          if (ca) {
            debug("Connected Account for ", caAttr, ca && ca.dataValues);
            return ca;
          }
          debug("Creating Connected Account", caAttr);
          return ConnectedAccount.create(caAttr);
        })
        .then(ca => {
          connectedAccount = ca;
          if (!ca.CollectiveId) {
            return Collective.findOne({ where: userAttr });
          } else {
            return ca.getCollective();
          }
        })
        .then(userCollective => {
          if (userCollective && userCollective.CreatedByUserId) {
            debug("User Collective Found", userCollective && userCollective.dataValues);
            return userCollective;
          }
          // If we cannot find an existing user for this contributor,
          // we fetch extra info from Github API and create a new user
          return fetchGithubUser(contributor)
            .then(json => {
              if (json && json.name) {
                userAttr.name = json.name;
                userAttr.website = json.blog;
                userAttr.email = json.email;
              }
              debug("findOrCreateUserWithCollective", userAttr);
              return User.findOne({where: { email: json.email } })
              .then(u => u || User.createUserWithCollective(Object.assign({}, userAttr)))
              .then(u => u.collective)
            });
        })
        .then(userCollective => contributorUserCollective = userCollective)
        .then(() => {
          debug("addConnectedAccount", connectedAccount && connectedAccount.dataValues, "to contributor user collective", contributorUserCollective.dataValues)
          return contributorUserCollective.addConnectedAccount(connectedAccount)
        })
        .then(() => _addUserToCollective(createdCollective, { id: contributorUserCollective.CreatedByUserId, CollectiveId: contributorUserCollective.id }, options));
      } else {
        return Promise.resolve();
      }
    }))
    .then(() => {
      const data = {
        firstName: creatorUser.firstName,
        lastName: creatorUser.lastName,
        collective: createdCollective.info
      };
      debug("sending github.signup to", creatorUser.email, "with data", data);
      return emailLib.send('github.signup', creatorUser.email, data);
    })
    .tap(() => res.send(createdCollective.info))
    .catch(next);
};

/**
 * Update.
 */
export const update = (req, res, next) => {
  const whitelist = [
    'name',
    'mission',
    'description',
    'longDescription',
    'currency',
    'image',
    'backgroundImage',
    'isActive'
  ];

  const updatedCollectiveAttrs = _.pick(req.required.group, whitelist);

  updatedCollectiveAttrs.LastEditedByUserId = req.remoteUser.id;

  // Need to handle settings separately, since it's an object
  if (req.required.group.settings) {
    updatedCollectiveAttrs.settings = Object.assign(req.collective.settings || {}, req.required.group.settings);
  }

  return req.collective.update(updatedCollectiveAttrs)
    .then(collective => res.send(collective.info))
    .catch(next)
};

export const updateSettings = (req, res, next) => {
  putThankDonationOptInIntoNotifTable(req.collective.id, req.required.group.settings)
    .then(() => doUpdate(['settings'], req, res, next))
    .catch(next);
};

function putThankDonationOptInIntoNotifTable(CollectiveId, collectiveSettings) {
  const twitterSettings = collectiveSettings && collectiveSettings.twitter;
  const attrs = {
    channel: 'twitter',
    type: activities.COLLECTIVE_TRANSACTION_CREATED,
    CollectiveId
  };

  const thankDonationEnabled = twitterSettings.thankDonationEnabled;
  delete twitterSettings.thankDonationEnabled;
  if (thankDonationEnabled) {
    return Notification.findOne({where: attrs})
      .then(n => n || Notification.create(Object.assign({active:true}, attrs)));
  } else {
    return Notification.findOne({where: attrs})
      .then(n => n && n.destroy());
  }
}

function doUpdate(whitelist, req, res, next) {
  whitelist.forEach((prop) => {
    if (req.required.group[prop]) {
      if (req.collective[prop] && typeof req.collective[prop] === 'object') {
        req.collective[prop] = Object.assign(req.collective[prop], req.required.group[prop]);
      } else {
        req.collective[prop] = req.required.group[prop];
      }
    }
  });

  req.collective.updatedAt = new Date();

  req.collective
    .save()
    .then((collective) => res.send(collective.info))
    .catch(next);
}

/**
 * Get collective content.
 */
export const getOne = (req, res, next) => {
  const collective = req.collective.info;
  const aggregate = (array, attribute) => {
    return array.map(d => d[attribute]).reduce((a, b) => a + b, 0);
  };
  const getHostAdmins = () => {
    return models.Member.findAll({
      where: {
        CollectiveId: req.collective.HostCollectiveId,
        role: 'ADMIN'
      },
      include: [ { model: models.Collective, as: 'memberCollective' } ]
    }).map(member => {
      return {
        UserId: member.memberCollective.data && member.memberCollective.data.UserId,
        UserCollectiveId: member.MemberCollectiveId,
        slug: member.memberCollective.slug
      }
    })
  }
  const getRelatedCollectives = () => {
    // don't fetch related collectives for supercollectives for now
    if (req.collective.isSupercollective) return Promise.resolve();
    else return req.collective.getRelatedCollectives();
  }
  Promise.all([
    req.collective.getConnectedAccounts({ where: { service: 'paypal' }}),
    req.collective.getBalance(),
    req.collective.getYearlyIncome(),
    req.collective.getTotalAmountReceived(),
    req.collective.getBackersCount(),
    req.collective.getTwitterSettings(),
    getRelatedCollectives(),
    req.collective.getSuperCollectiveData(),
    req.collective.getHostCollective(),
    getHostAdmins()
    ])
  .then(values => {
    collective.hasPaypal = values[0] && values[0].service === 'paypal';
    collective.balance = values[1];
    collective.yearlyIncome = values[2];
    collective.donationTotal = values[3];
    collective.backersCount = values[4];
    collective.contributorsCount = (collective.data && collective.data.githubContributors) ? Object.keys(collective.data.githubContributors).length : 0;
    collective.settings = collective.settings || {};
    collective.settings.twitter = values[5];
    collective.related = values[6];
    collective.superCollectiveData = values[7];
    collective.host = values[8] && values[8].info;
    collective.host.admins = values[9];
    if (collective.superCollectiveData) {
      collective.collectivesCount = collective.superCollectiveData.length;
      collective.contributorsCount += aggregate(collective.superCollectiveData, 'contributorsCount');
      collective.yearlyIncome += aggregate(collective.superCollectiveData, 'yearlyIncome');
      collective.backersCount += aggregate(collective.superCollectiveData, 'backersCount');
      collective.donationTotal += aggregate(collective.superCollectiveData, 'donationTotal');
    }
    return collective;
  })
  .then(collective => res.send(collective))
  .catch(next)
};

/**
 * Add a user to a collective.
 */
export const addUser = (req, res, next) => {
  const options = {
    role: req.body.role || roles.BACKER,
    remoteUser: req.remoteUser
  };

  _addUserToCollective(req.collective, req.user, options)
    .tap(() => res.send({success: true}))
    .catch(next);
};

/**
 * Get array of unique collective tags
 */
export const getCollectiveTags = (req, res, next) => {
  return queries.getUniqueCollectiveTags()
  .then(tags => res.send(tags))
  .catch(next);
};

export const getTransactions = (req, res, next) => {
  const where = {
    CollectiveId: req.collective.id
  };

  if (req.query.donation || req.query.type === 'donations') {
    where.amount = {
      $gt: 0
    };
  } else if (req.query.expense || req.query.type === 'expenses') {
    where.amount = {
      $lt: 0
    };
  }

  if (req.query.exclude) {
    where.$or = [ { type: { $ne: req.query.exclude } }, { type: { $eq: null } } ];
  }

  const query = _.merge({
    where,
    include: { model: models.Order },
    order: [[req.sorting.key, req.sorting.dir]]
  }, req.pagination);

  models.Transaction
    .findAndCountAll(query)
    .then((transactions) => {

      // Set headers for pagination.
      req.pagination.total = transactions.count;
      res.set({
        Link: getLinkHeader(getRequestedUrl(req), req.pagination)
      });

      res.send(transactions.rows.map(transaction => Object.assign({}, transaction.info, {'description': (transaction.Order && transaction.Order.title) || transaction.description })));
    })
    .catch(next);
};
