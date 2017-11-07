import models, { sequelize } from '../models';
import { getListOfAccessibleUsers } from '../lib/auth';
import { type } from '../constants/transactions';
import DataLoader from 'dataloader';
import { get, groupBy } from 'lodash';
import debugLib from 'debug';
const debug = debugLib('loaders');

const sortResults = (keys, results, attribute = 'id', defaultValue) => {
  debug("sortResults", attribute, results.length);
  const resultsById = {};
  results.forEach(r => {
    let key;
    const dataValues = r.dataValues || r;
    if (attribute.indexOf(':') !== -1) {
      const keyComponents = [];
      attribute.split(':').forEach(attr => {
        keyComponents.push(dataValues[attr]);
      });
      key = keyComponents.join(':');
    } else {
      key = dataValues[attribute];
    }
    if (!key) {
      return;
    }
    // If the default value is an array
    // e.g. when we want to return all the paymentMethods for a list of collective ids.
    if (defaultValue instanceof Array) {
      resultsById[key] = resultsById[key] || [];
      resultsById[key].push(r);
    } else {
      resultsById[key] = r;
    }
  });
  return keys.map(id => resultsById[id] || defaultValue);
}

export const loaders = (req) => {

  const cache = {};
  const createDataLoaderWithOptions = (batchFunction, options = {}) => {
    const cacheKey = JSON.stringify(options);
    cache[cacheKey] = cache[cacheKey] || new DataLoader(keys => batchFunction(keys, options));
    return cache[cacheKey];
  }

  return {
    collective: {
      findById: new DataLoader(ids => models.Collective
        .findAll({ where: { id: { $in: ids }}})
        .then(collectives => sortResults(ids, collectives))
      ),
      balance: new DataLoader(ids => models.Transaction.findAll({
          attributes: [
            'CollectiveId',
            [ sequelize.fn('COALESCE', sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 0), 'balance' ]
          ],
          where: { CollectiveId: { $in: ids } },
          group: ['CollectiveId']
        })
        .then(results => sortResults(ids, results, 'CollectiveId'))
        .map(result => get(result, 'dataValues.balance') || 0)
      ),
      stats: {
        collectives: new DataLoader(ids => models.Collective.findAll({
            attributes: [
              'HostCollectiveId',
              [ sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count' ]
            ],
            where: { HostCollectiveId: { $in: ids } },
            group: ['HostCollectiveId']
          })
          .then(results => sortResults(ids, results, 'TierId'))
          .map(result => get(result, 'dataValues.count') || 0)
        ),
        expenses: new DataLoader(ids => models.Expense.findAll({
          attributes: [
            'CollectiveId',
            'status',
            [ sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count' ]
          ],
          where: { CollectiveId: { $in: ids } },
          group: ['CollectiveId', 'status']
        })
        .then(rows => {
          const results = groupBy(rows, "CollectiveId");
          return Object.keys(results).map(CollectiveId => {
            const stats = {};
            results[CollectiveId].map(e => e.dataValues).map(stat => {
              stats[stat.status] = stat.count;
            });
            return {
              CollectiveId: Number(CollectiveId),
              ...stats
            };
          });
        })
        .then(results => sortResults(ids, results, 'CollectiveId'))
        )
      }
    },
    // This one is tricky. We need to make sure that the remoteUser can view the personal details of the user.
    getUserDetailsByCollectiveId: new DataLoader(UserCollectiveIds => getListOfAccessibleUsers(req.remoteUser, UserCollectiveIds)
      .then(accessibleUserCollectiveIds => models.User.findAll({ where: { CollectiveId: { $in: accessibleUserCollectiveIds } }}))
      .then(results => sortResults(UserCollectiveIds, results, 'CollectiveId', {}))
    ),
    tiers: {
      findById: new DataLoader(ids => models.Tier
        .findAll({ where: { id: { $in: ids }}})
        .then(results => sortResults(ids, results, 'id'))
      ),
      totalDistinctOrders: new DataLoader(ids => models.Order.findAll({
          attributes: [
            'TierId',
            [ sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId'))), 0), 'count' ]
          ],
          where: { TierId: { $in: ids } },
          group: ['TierId']
        })
        .then(results => sortResults(ids, results, 'TierId'))
        .map(result => get(result, 'dataValues.count') || 0)
      ),
      totalOrders: new DataLoader(ids => models.Order.findAll({
          attributes: [
            'TierId',
            [ sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count' ]
          ],
          where: { TierId: { $in: ids }, processedAt: { $ne: null } },
          group: ['TierId']
        })
        .then(results => sortResults(ids, results, 'TierId'))
        .map(result => get(result, 'dataValues.count') || 0)
      )
    },
    paymentMethods: {
      findById: new DataLoader(ids => models.PaymentMethod
        .findAll({ where: { id: { $in: ids }}})
        .then(results => sortResults(ids, results, 'id'))
      ),
      findByCollectiveId: new DataLoader(CollectiveIds => models.PaymentMethod
        .findAll({ where: {
          CollectiveId: { $in: CollectiveIds },
          name: { $ne: null },
          archivedAt: null
        }})
        .then(results => sortResults(CollectiveIds, results, 'CollectiveId', []))
      )
    },
    orders: {
      findByMembership: new DataLoader(combinedKeys => models.Order
          .findAll({
            where: {
              CollectiveId: { $in: combinedKeys.map(k => k.split(':')[0]) },
              FromCollectiveId: { $in: combinedKeys.map(k => k.split(':')[1] )}
            },
            order: [['createdAt', 'DESC']]
          })
          .then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', []))
      ),
      stats: {
        transactions: new DataLoader(ids => models.Transaction.findAll({
            attributes: [
              'OrderId',
              [ sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count' ]
            ],
            where: { OrderId: { $in: ids } },
            group: ['OrderId']
          })
          .then(results => sortResults(ids, results, 'OrderId'))
          .map(result => get(result, 'dataValues.count') || 0)
        ),
        totalTransactions: new DataLoader(keys => models.Transaction.findAll({
            attributes: ['OrderId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount'] ],
            where: { OrderId: { $in: keys } },
            group: ['OrderId']
          })
          .then(results => sortResults(keys, results, 'OrderId'))
          .map(result => get(result, 'dataValues.totalAmount') || 0)
        )
      }
    },
    members: {
      transactions: new DataLoader(combinedKeys => models.Transaction
          .findAll({
            where: {
              CollectiveId: { $in: combinedKeys.map(k => k.split(':')[0]) },
              FromCollectiveId: { $in: combinedKeys.map(k => k.split(':')[1] )}
            },
            order: [['createdAt', 'DESC']]
          })
          .then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', []))          
        )
    },
    transactions: {
      findByOrderId: options => createDataLoaderWithOptions((OrderIds, options) => {
        return models.Transaction
          .findAll({
            where: {
              OrderId: { $in: OrderIds },
              ... options.where
            },
            order: [['createdAt', 'DESC']]
          })
          .then(results => sortResults(OrderIds, results, 'OrderId', []))
        }, options),
      totalAmountDonatedFromTo: new DataLoader(keys => models.Transaction.findAll({
        attributes: ['FromCollectiveId', 'CollectiveId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount'] ],
        where: {
          FromCollectiveId: { $in: keys.map(k => k.FromCollectiveId) },
          CollectiveId: { $in: keys.map(k => k.CollectiveId) },
          type: type.CREDIT
        },
        group: ['FromCollectiveId', 'CollectiveId']
      })
      .then(results => {
        const resultsByKey = {};
        results.forEach(r => {
          resultsByKey[`${r.FromCollectiveId}-${r.CollectiveId}`] = r.dataValues.totalAmount;
        });
        return keys.map(key => {
          return resultsByKey[`${key.FromCollectiveId}-${key.CollectiveId}`] || 0;
        })
      }))
    }
  }
};

export function middleware(req, res, next) {
    req.loaders = loaders(req);
    next();
}