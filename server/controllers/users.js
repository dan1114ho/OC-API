/**
 * Dependencies.
 */
var _ = require('lodash');
var Bluebird = require('bluebird');
var async = require('async');
var userlib = require('../lib/userlib');
var generateURLSafeToken = require('../lib/utils').generateURLSafeToken;
var imageUrlToAmazonUrl = require('../lib/imageUrlToAmazonUrl');
var constants = require('../constants/activities');

/**
 * Controller.
 */
module.exports = function(app) {

  /**
   * Internal Dependencies.
   */
  var models = app.set('models');
  var User = models.User;
  var Activity = models.Activity;
  var UserGroup = models.UserGroup;
  var groups = require('../controllers/groups')(app);
  var sendEmail = require('../lib/email')(app).send;
  var errors = app.errors;

  /**
   * Private methods.
   */

  var getUserGroups = (UserId) => {
    return UserGroup.findAll({
      where: {
        UserId
      }
    })
    .then((userGroups) => _.pluck(userGroups, 'info'));
  };

  var getGroupsFromUser = function(req, options) {
    // UserGroup has multiple entries for a user and group because
    // of the multiple roles. We will get the unique groups in-memory for now
    // because of the small number of groups.
    // Distinct queries are not supported by sequelize yet.
    return req.user
      .getGroups(options)
      .then(groups => _.uniq(groups, 'id'))
      .map((group) => { // sequelize uses bluebird
        return _.extend(group.info, {
          activities: group.Activities
        });
      });
  };

  var getGroupsFromUserWithRoles = function(req, options) {
    /**
     * This isn't the best way to get the user role but I couldn't find a
     * clean way to do it with sequelize. If you find it, please refactor.
     */

    return Bluebird.props({
      usergroups: getUserGroups(req.user.id),
      groups: getGroupsFromUser(req, options)
    })
    .then((props) => {
      var usergroups = props.usergroups || [];
      var groups = props.groups || [];

      return groups.map((group) => {
        var usergroup = _.find(usergroups, { GroupId: group.id }) || {};
        return _.extend(group, { role: usergroup.role });
      });
    });
  };

  var updatePaypalEmail = function(req, res, next) {
    var required = req.required || {};

    req.user.paypalEmail = required.paypalEmail;

    req.user.save()
    .then((user) => res.send(user.info))
    .catch(next);
  };

  var updateAvatar = function(req, res, next) {
    var required = req.required || {};

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
        userlib.fetchAvatar(results.updateFields, (err, user) => {
          var avatar = user.avatar;
          if (avatar && avatar.indexOf('/static') !== 0 && avatar.indexOf(app.knox.bucket) === -1)
          {
            imageUrlToAmazonUrl(app.knox, avatar, (error, aws_src) => {
              user.avatar = error ? user.avatar : aws_src;
              cb(null, user);
            });
          }
          else
          {
            cb(null, user);
          }
        });
      }],

      update: ['fetchUserAvatar', (cb, results) => {
        var user = results.fetchUserAvatar;

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

    var userData = req.body.userData;
    userData.email = req.user.email;
    userData.ip = req.ip;

    userlib.resolveUserAvatars(userData, (err, results) => {
      res.send(results);
    });
  };

  var getBalancePromise = function(GroupId) {
    return new Bluebird((resolve, reject) => {
      groups.getBalance(GroupId, (err, balance) => {
        return err ? reject(err) : resolve(balance);
      });
    });
  };

  var _create = function(user, cb) {
    userlib.fetchInfo(user, (err, user) => {
      User
        .create(user)
        .tap((dbUser) => {
          Activity.create({
            type: constants.USER_CREATED,
            UserId: dbUser.id,
            data: {user: dbUser.info}
          });
        })
        .then((dbUser) => {
          cb(null, dbUser);
        })
        .catch(cb);
    });
  };

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
        User.find(id)
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
        var user = results.getUser;

        user.resetPasswordTokenHash = null;
        user.resetPasswordSentAt = null;
        user.password = password;

        user.save()
          .done(cb);
      }]

    }, err => {
      if (err) return next(err);

      return res.send({ success: true });
    });
  };

  /**
   * Public methods.
   */
  return {

    /**
     * Create a user.
     */
    create: function(req, res, next) {
      var user = req.required.user;
      user.ApplicationId = req.application.id;

      _create(user, (err, user) => {
        if (err) return next(err);
        res.send(user.info);
      });
    },

    _create,

    /**
     * Get token.
     */
    getToken: function(req, res) {
      res.send({
        access_token: req.user.jwt(req.application),
        refresh_token: req.user.refresh_token
      });
    },

    /**
     * Show.
     */
    show: function(req, res, next) {
      if (req.remoteUser.id === req.user.id) {
        req.user.getStripeAccount()
          .then((account) => {
            var response = _.extend({}, req.user.info, { stripeAccount: account });

            res.send(response);
          })
          .catch(next);
      } else {
        res.send(req.user.show);
      }
    },

    /**
     * Get a user's groups.
     */
    getGroups: function(req, res, next) {
      // Follows json api spec http://jsonapi.org/format/#fetching-includes
      var include = req.query.include;
      var withRoles = _.contains(include, 'usergroup.role');
      var options = {
        include: []
      };

      if (_.contains(include, 'activities')) {
        options.include.push({ model: Activity });
      }

      var promise = withRoles ?
        getGroupsFromUserWithRoles(req, options) :
        getGroupsFromUser(req, options);

      promise.map((group) => {
        return getBalancePromise(group.id)
        .then((balance) => _.extend(group, { balance }))
      })
      .then((out) => res.send(out))
      .catch(next);
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
