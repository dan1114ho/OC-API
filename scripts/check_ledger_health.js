/*
 * This script runs through a few checks and lets us know if something is off
 * Note, best to run this script on a prod_snapshot locally, until we create a read-only follower
 */
import models, { sequelize } from '../server/models';

const VERBOSE = true;

const done = (err) => {
  if (err) console.log('err', err);
  console.log('done!');
  process.exit();
}

const checkHostsUserOrOrg = () => {

  console.log('\n>>> Checking Hosts to be USER or ORG...')

  const hostErrors = [];

  // Check that a Host is a User or an ORG
  return sequelize.query(`
    WITH hosts as (SELECT distinct("HostCollectiveId") from "Collectives")

    SELECT * from "Collectives"
    WHERE id IN (SELECT * FROM hosts);
    `, { type: sequelize.QueryTypes.SELECT})
    .then(hostCollectives => {
      console.log('\t>>> Hosts found: ', hostCollectives.length);
      return hostCollectives
    })
    .each(hostCollective => {
      if (hostCollective.type !== 'USER' && hostCollective.type !== 'ORGANIZATION') {
        hostErrors.push(hostCollective);
      }
    })
    .then(() => {
      console.log('\t>>> Hosts found with incorrect type: ', hostErrors.length)
      if (VERBOSE)
        console.log(hostErrors && hostErrors.map(h => Object.assign({slug: h.slug, type: h.type})));
    });
} 

// Ensure all Collectives are setup properly
const checkHostCollectives = () => {

  console.log('\n>>> Checking Host Collectives...')

  // Check that a collective is not setup to host itself or be it's own parentCollectiveId
  return models.Collective.findAll({
    where: {
      HostCollectiveId: {
        $col: 'id'
      }
    }
  })
  .then(selfReferencingHosts => {
    console.log('\t>>> Self-referencing Hosts found: ', selfReferencingHosts.length)
    if (VERBOSE)
      console.log(selfReferencingHosts && selfReferencingHosts.map(h => Object.assign({slug: h.slug, id: h.id})))
  })
}

// TODO: make sure every Host has a Stripe Account
const checkHostStripeAccount = () => {
  return sequelize.query(`
  WITH hosts AS 
    (SELECT DISTINCT("HostCollectiveId") AS id FROM "Collectives" c 
      WHERE "HostCollectiveId" IS NOT NULL)
    
  SELECT h.id FROM hosts h
  LEFT JOIN "ConnectedAccounts" ca ON (h.id = ca."CollectiveId")
  WHERE ca."CollectiveId" IS NULL
    `, { type: sequelize.QueryTypes.SELECT})
  .then(hostsWithoutStripe => {
    console.log('\t>>> Hosts without Stripe: ', hostsWithoutStripe.length)
    if (VERBOSE)
      console.log(hostsWithoutStripe.map(h => h.id).join(', '));
  })
}

const checkUsersAndOrgs = () => {

  console.log('\n>>> Checking USER and ORG Collectives')

  // Check that no User or ORG has a HostCollectiveId or ParentCollectiveId
  return models.Collective.findAll({
    where: {
      type: {
        $or: ['USER', 'ORGANIZATION']
      },
      HostCollectiveId: {
        $ne: null
      }
    }
  })
  .then(collectives => {
    console.log('\t>>> USER or ORGs found with HostCollectiveId: ', collectives.length)
    if (VERBOSE)
      console.log(collectives.map(c => Object.assign({slug: c.slug, HostCollectiveId: c.HostCollectiveId})))
  })
  // TODO: Check that no non-USER Collective is directly linked to a USER
  .then(() => models.User.findAll({
    attributes: ['CollectiveId']
  }))
  .then(userCollectives => models.Collective.findAll({
    where: {
      id: {
        $in: userCollectives.map(u => u.CollectiveId)
      },
      type: {
        $ne: 'USER'
      }
    }
  }))
  .then(improperlyLinkedCollectives => {
    console.log('\t>>> non-User collectives that are linked to a USER: ', improperlyLinkedCollectives.length);
    if (VERBOSE)
      console.log(improperlyLinkedCollectives.map(c => Object.assign({id: c.id, slug: c.slug})));
  })
}

const checkMembers = () => {
  console.log('\n>>> Checking Members table');

  return models.Member.findAll({
    where: {
      MemberCollectiveId: {
        $col: 'CollectiveId'
      }
    }
  })
  .then(circularMembers => {
    console.log('\t>>> Members with CollectiveId = MemberCollectiveId: ', circularMembers.length)
    if (VERBOSE)
      console.log(circularMembers.map(cm => cm.id).join(', '))
  })
}

// Check orders

const checkOrders = () => {

  console.log('>>> Check orders');

  // Check that FromCollectiveId on an Order matches all Transactions
  const brokenOrders = [];

  return sequelize.query(`
    SELECT * from "Orders"
    WHERE "deletedAt" is null AND "processedAt" is not null AND "CollectiveId" != 1
    `, { type: sequelize.QueryTypes.SELECT
    })
    .then(orders => {
      console.log('\t>>> orders found: ', orders.length);
      return orders;
    })
    .each(order => {
      return sequelize.query(`
        SELECT distinct("FromCollectiveId") from "Transactions"
        WHERE "OrderId" = :orderId AND type LIKE 'CREDIT' AND "deletedAt" is null
        `, {
          type: sequelize.QueryTypes.SELECT,
          replacements: {
            orderId: order.id
          }
        })
        .then(FromCollectiveIds => {
          if (FromCollectiveIds.length > 1) {
            brokenOrders.push(order.id);
          }
          return Promise.resolve();
        })
    })
    .then(() => {
      console.log('\t>>> orders found with mismatched FromCollectiveId: ', brokenOrders.length);
      if (VERBOSE)
        console.log(brokenOrders)
    })
}


// Check all transactions
const checkTransactions = () => {

  console.log('\n>>> Checking Transactions...')

  // Check every transaction has a "FromCollectiveId"
  return models.Transaction.count({
    where: {
      FromCollectiveId: {
        $eq: null
      }
    }
  })
  .then(txsWithoutFromCollectiveId => {
    console.log('\t>>> Transactions without `FromCollectiveId`:', txsWithoutFromCollectiveId);
  })

  // Check no transaction has same "FromCollectiveId" and "CollectiveId"
  .then(() => models.Transaction.findAll({
    where: {
      CollectiveId: {
        $col: 'FromCollectiveId'
      }
    }
  }))
  .then(circularTxs => {
    console.log('\t>>> Transactions with same source and destination: ', circularTxs.length)
    if (VERBOSE) 
      console.log(circularTxs.map(t => Object.assign({id: t.id})))
  })

  // check no transactions without TransactionGroup
  .then(() => models.Transaction.count({
    where: {
      TransactionGroup: {
        $eq: null
      }
    }
  }))
  .then(txnsWithoutTransactionGroup => {
    console.log('\t>>> Transactions without `TransactionGroup`: ', txnsWithoutTransactionGroup)
  })

  // Check every Order has even number of entries
  .then(() => sequelize.query(`
    SELECT "OrderId" FROM "Transactions"
        WHERE "OrderId" IS NOT NULL and "deletedAt" is null
          GROUP BY "OrderId"
          HAVING COUNT(*) % 2 != 0 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddOrderIds => {
    console.log('\t>>> Orders with odd (not multiple of 2) number of transactions: ', oddOrderIds.length)
  })

  // Check every Expense has a double Entry
  .then(() => sequelize.query(`
    SELECT "ExpenseId" FROM "Transactions"
        WHERE "ExpenseId" IS NOT NULL and "deletedAt" is null
          GROUP BY "ExpenseId"
          HAVING COUNT(*) != 2 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddExpenseIds => {
    console.log('\t>>> Expenses with less than or more than 2 transactions: ', oddExpenseIds.length)
    if (VERBOSE)
      console.log(oddExpenseIds)
  })

  // Check all TransactionGroups have two entries, one CREDIT and one DEBIT
  .then(() => sequelize.query(`
    SELECT "TransactionGroup" FROM "Transactions"
        WHERE "TransactionGroup" IS NOT NULL and "deletedAt" is null
          GROUP BY "TransactionGroup"
          HAVING COUNT(*) != 2 
    `, {type: sequelize.QueryTypes.SELECT}))
  .then(oddTxnGroups => {
    console.log('\t>>> Transaction groups that are not pairs: ', oddTxnGroups.length)
    if (VERBOSE) 
      console.log(oddTxnGroups);
  })

  // Check no transactions without either an Expense or Order
  .then(() => models.Transaction.findAll({
    where: {
      OrderId: {
        $eq: null
      },
      ExpenseId: {
        $eq: null
      }
    }
  }))
  .then(txnsWithoutOrderOrExpenses => {
    console.log('\t>>> Transactions without OrderId or ExpenseId: ', txnsWithoutOrderOrExpenses.length)
    if (VERBOSE)
      txnsWithoutOrderOrExpenses.map(t => Object.assign({id: t.id}));
  })

  // Check that various fees and amounts add up
  // TODO
}

const checkCollectiveBalance = () => {

  const brokenCollectives = [];
  console.log('>>> Checking balance of each (non-USER, non-ORG) collective');
  return models.Collective.findAll({
    where: {
      $or: [{type: 'COLLECTIVE'}, {type: 'EVENT'}]
    }
  })
  .then(collectives => {
    console.log('\t>>> Collectives found:', collectives.length);
    return collectives;
  })
  .each(collective => {
    return collective.getBalance()
      .then(balance => {
        if (balance < 0) {
          brokenCollectives.push(collective)
        }
        return Promise.resolve();
      })
  })
  .then(() => {
    console.log('\t>>> Collectives with negative balance: ', brokenCollectives.length);
    if (VERBOSE)
      console.log(brokenCollectives.map(c => Object.assign({id: c.id, slug: c.slug})))
  })

}

const run = () => {
  
  return checkHostsUserOrOrg()
  .then(() => checkHostCollectives())
  .then(() => checkHostStripeAccount())
  .then(() => checkUsersAndOrgs())
  .then(() => checkMembers())
  .then(() => checkOrders())
  .then(() => checkTransactions())
  .then(() => checkCollectiveBalance())
  .then(() => done())
  .catch(done)
}

run();