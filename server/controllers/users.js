/**
 * Dependencies.
 */
const _ = require('lodash');
const async = require('async');
const userlib = require('../lib/userlib');
const generateURLSafeToken = require('../lib/utils').generateURLSafeToken;
const imageUrlToAmazonUrl = require('../lib/imageUrlToAmazonUrl');
const constants = require('../constants/activities');
const sequelize = require('sequelize');

/**
 * Controller.
 */
module.exports = (app) => {

  /**
   * Internal Dependencies.
   */
  const models = app.set('models');
  const User = models.User;
  const Activity = models.Activity;
  const UserGroup = models.UserGroup;
  const sendEmail = require('../lib/email')(app).send;
  const errors = app.errors;

  /**
   *
   * Private methods.
   *
   */

  const getUserGroups = (UserId) => {
    return UserGroup.findAll({
      where: {
        UserId
      }
    })
    .then((userGroups) => _.pluck(userGroups, 'info'));
  };

  const getGroupsFromUser = (req, options) => {
    // UserGroup has multiple entries for a user and group because
    // of the multiple roles. We will get the unique groups in-memory for now
    // because of the small number of groups.
    // Distinct queries are not supported by sequelize yet.
    return req.user
      .getGroups(options)
      .then(groups => _.uniq(groups, 'id'));
  };

  const updatePaypalEmail = (req, res, next) => {
    const required = req.required || {};

    req.user.paypalEmail = required.paypalEmail;

    req.user.save()
    .then((user) => res.send(user.info))
    .catch(next);
  };

  const updateAvatar = (req, res, next) => {
    const required = req.required || {};

    req.user.avatar = required.avatar;

    req.user.save()
    .then((user) => res.send(user.info))
    .catch(next);
  };

  /*
   * End point to update user info from the public donation page
   * Only works if password is null, as an extra precaution
   */

  const updateUserWithoutLoggedIn = (req, res, next) => {
    if (req.user.hasPassword()) {
      return next(new errors.BadRequest('Can\'t update user with password from this route'));
    }

    async.auto({
      updateFields: (cb) => {
        ['name',
         'twitterHandle',
         'website',
         'avatar'
         ].forEach((prop) => {
          if (req.required.user[prop]) {
            req.user[prop] = req.required.user[prop];
          }
        });

        cb(null, req.user);
      },

      fetchUserAvatar: ['updateFields', (cb, results) => {
        userlib.fetchAvatar(results.updateFields).tap(user => {
          const avatar = user.avatar;
          if (avatar && avatar.indexOf('/static') !== 0 && avatar.indexOf(app.knox.bucket) === -1) {
            imageUrlToAmazonUrl(app.knox, avatar, (error, aws_src) => {
              user.avatar = error ? user.avatar : aws_src;
              cb(null, user);
            });
          }
          else {
            cb(null, user);
          }
        })
        .catch(cb);
      }],

      update: ['fetchUserAvatar', (cb, results) => {
        const user = results.fetchUserAvatar;

        user.updatedAt = new Date();
        user
          .save()
          .then(u => cb(null, u.info))
          .catch(cb);
      }]
    }, (err, results) => {
      if (err) return next(err);
      res.send(results.update);
    });
  };

  /*
   * End point for social media avatar lookup from the public donation page
   * Only works if password is null, as an extra precaution
   */
  const getSocialMediaAvatars = (req, res, next) => {
    if (req.user.hasPassword()) {
      return next(new errors.BadRequest('Can\'t lookup user avatars with password from this route'));
    }

    const userData = req.body.userData;
    userData.email = req.user.email;
    userData.ip = req.ip;

    userlib.resolveUserAvatars(userData, (err, results) => {
      res.send(results);
    });
  };

  const _create = user => userlib.fetchInfo(user)
    .then(user => User.create(user))
    .tap(dbUser => Activity.create({
      type: constants.USER_CREATED,
      UserId: dbUser.id,
      data: {user: dbUser.info}
    }));

  const updatePassword = (req, res, next) => {
    const password= req.required.password;
    const passwordConfirmation = req.required.passwordConfirmation;

    if (password !== passwordConfirmation) {
      return next(new errors.BadRequest('password and passwordConfirmation don\'t match'));
    }

    req.user.password = password;

    req.user.save()
      .then(() => res.send({success: true}))
      .catch(next);
  };

  const forgotPassword = (req, res, next) => {
    const email = req.required.email;

    async.auto({
      getUser: (cb) => {
        User.findOne({
          where: { email }
        })
        .then(user => {
          if (!user) {
            return next(new errors.BadRequest(`User with email ${email} doesn't exist`));
          }

          cb(null, user);
        })
        .catch(cb);
      },

      generateToken: ['getUser', (cb, results) => {
        const user = results.getUser;
        const token = generateURLSafeToken(20);

        user.resetPasswordToken = token; // only place where we have token in plaintext
        user.resetPasswordSentAt = new Date();

        user.save()
        .then(() => cb(null, token))
        .catch(cb);
      }],

      sendEmailToUser: ['generateToken', (cb, results) => {
        const user = results.getUser;
        const email = results.getUser.email;
        const resetToken = results.generateToken;
        const resetUrl = user.generateResetUrl(resetToken);

        sendEmail('user.forgot.password', email, {
          resetUrl,
          resetToken
        })
        .then(() => cb())
        .catch(cb);
      }]
    }, (err) => {
      if (err) return next(err);

      return res.send({ success: true });
    });
  };

  const resetPassword = (req, res, next) => {
    const resetToken = req.params.reset_token;
    const id = User.decryptId(req.params.userid_enc);
    const password= req.required.password;
    const passwordConfirmation = req.required.passwordConfirmation;

    if (password !== passwordConfirmation) {
      return next(new errors.BadRequest('password and passwordConfirmation don\'t match'));
    }

    async.auto({
      getUser: cb => {
        User.findById(id)
        .then(user => {
          if (!user) {
            return next(new errors.BadRequest(`User with id ${id} not found`));
          }

          cb(null, user);
        })
        .catch(cb);
      },

      checkResetToken: ['getUser', (cb, results) => {
        const user = results.getUser;
        user.checkResetToken(resetToken, cb);
      }],

      updateUser: ['checkResetToken', (cb, results) => {
        const user = results.getUser;

        user.resetPasswordTokenHash = null;
        user.resetPasswordSentAt = null;
        user.password = password;

        user.save()
          .then(() => cb())
          .catch(cb);
      }]

    }, err => {
      if (err) return next(err);

      return res.send({ success: true });
    });
  };

  /**
   *
   * Public methods.
   *
   */
  return {

    /**
     * Create a user.
     */
    create: (req, res, next) => {
      const user = req.required.user;
      user.ApplicationId = req.application.id;

      _create(user)
        .tap(user => res.send(user.info))
        .catch(next);
    },

    _create,

    /**
     * Get token.
     */
    getToken: (req, res) => {
      res.send({
        access_token: req.user.jwt(req.application),
        refresh_token: req.user.refresh_token
      });
    },

    /**
     * Show.
     */
    show: (req, res, next) => {

      const userData = req.user.show;

      if (req.remoteUser && req.remoteUser.id === req.user.id) {
        req.user.getStripeAccount()
          .then((account) => {
            const response = Object.assign(userData, req.user.info, { stripeAccount: account });
            res.send(response);
          })
          .catch(next);
      } else if (req.query.profile) {
        var groups;
        req.user
        .getGroups()
        .then(results => {
          groups = results.map(g => Object.assign(g.minimal, { role: g.UserGroup.role, createdAt: g.UserGroup.createdAt }));
          return groups;
        })
        .then(groups => UserGroup.findAll({
          where: { GroupId: { $in: groups.map(g => g.id) } },
          attributes: ['GroupId', [ sequelize.fn('count', sequelize.col('GroupId')), 'members' ]],
          group: ['GroupId']
        }))
        .tap(counts => {
          const membersByGroupId = {};
          counts.map(g => { membersByGroupId[parseInt(g.GroupId,10)] = parseInt(g.dataValues.members, 10); } );
          userData.groups = groups.map(g => Object.assign(g, { members: membersByGroupId[parseInt(g.id, 10)] }));
          res.send(userData);
        })
        .catch(next);
      }
      else {
        res.send(userData);
      }
    },

    /**
     * Get a user's groups.
     */
    getGroups: (req, res, next) => {
      // Follows json api spec http://jsonapi.org/format/#fetching-includes
      const include = req.query.include;
      const withRoles = _.contains(include, 'usergroup.role');
      const options = {
        include: []
      };

      var groupObjects; // stores sequelize objects
      var groupData = []; // stores data to return

      return getGroupsFromUser(req, options)
      .tap(groups => groupObjects = groups)
      .then(groups => groups.map(group => groupData.push(group.info)))
      .then(() => groupObjects.map(groupObject => {
        const group = _.find(groupData, {id: groupObject.id})
        return _.extend(group, { balance: groupObject.getBalance() })
      }))
      .then(() => {
        if (withRoles) {
          return getUserGroups(req.user.id)
            .then(userGroups => groupData.map(group => {
              const userGroup = _.find(userGroups, { GroupId: group.id }) || {};
              return _.extend(group, { role: userGroup.role });
            }))
        } else {
          return null;
        }
      })
      .then(() => res.send(groupData))
      .catch(next)
    },

    updatePaypalEmail,
    updateAvatar,
    updateUserWithoutLoggedIn,
    getSocialMediaAvatars,
    updatePassword,
    forgotPassword,
    resetPassword
  };
};
