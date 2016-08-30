/**
 * Dependencies.
 */
import {getLinkHeader, getRequestedUrl} from '../lib/utils';
import _ from 'lodash';

/**
 * Controller.
 */
export default (app) => {

  /**
   * Internal Dependencies.
   */
  const models = app.set('models');
  const { Activity } = models;

  /**
   * Public methods.
   */
  return {

    /**
     * Get group's activities.
     */
    group(req, res, next) {
      const query = _.merge({
        where: {
          GroupId: req.group.id
        },
        order: [[req.sorting.key, req.sorting.dir]]
      }, req.pagination);

      Activity
        .findAndCountAll(query)
        .tap((activities) => {
          // Set headers for pagination.
          req.pagination.total = activities.count;
          res.set({
            Link: getLinkHeader(getRequestedUrl(req),
                                        req.pagination)
          });

          res.send(activities.rows);
        })
        .catch(next);
    },

    /**
     * Get user's activities.
     */
    user(req, res, next) {
      const query = _.merge({
        where: {
          UserId: req.user.id
        },
        order: [[req.sorting.key, req.sorting.dir]]
      }, req.pagination);

      Activity
        .findAndCountAll(query)
        .then((activities) => {

          // Set headers for pagination.
          req.pagination.total = activities.count;
          res.set({
            Link: getLinkHeader(getRequestedUrl(req), req.pagination)
          });

          res.send(activities.rows);
        })
        .catch(next);
    }

  };

};
