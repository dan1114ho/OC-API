import Temporal from 'sequelize-temporal';
import { TransactionTypes } from '../constants/transactions';

import status from '../constants/expense_status';
import CustomDataTypes from '../models/DataTypes';

export default function (Sequelize, DataTypes) {

  const Expense = Sequelize.define('Expense', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },

    UserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false
    },

    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false
    },

    currency: CustomDataTypes(DataTypes).currency,

    amount: {
      type: DataTypes.INTEGER,
      validate: { min: 1 },
      allowNull: false
    },

    description: {
      type: DataTypes.STRING,
      allowNull: false
    },

    payoutMethod: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [['paypal', 'manual', 'donation', 'other']],
          msg: 'Must be paypal, manual, donation or other'
        }
      },
      allowNull: false,
      defaultValue: 'manual'
    },

    privateMessage: DataTypes.STRING,
    attachment: DataTypes.STRING,
    category: DataTypes.STRING,
    vat: DataTypes.INTEGER,

    lastEditedById: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: status.PENDING,
      allowNull: false,
      validate: {
        isIn: {
          args: [Object.keys(status)],
          msg: `Must be in ${Object.keys(status)}`
        }
      }
    },

    incurredAt: {
      type: DataTypes.DATE,
      allowNull: false
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW,
      allowNull: false
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW,
      allowNull: false
    },

    deletedAt: {
      type: DataTypes.DATE
    }
  }, {
    paranoid: true,

    getterMethods: {
      info() {
        return {
          type: TransactionTypes.DEBIT,
          id: this.id,
          UserId: this.UserId,
          CollectiveId: this.CollectiveId,
          currency: this.currency,
          amount: this.amount,
          description: this.description,
          attachment: this.attachment,
          category: this.category,
          payoutMethod: this.payoutMethod,
          vat: this.vat,
          privateMessage: this.privateMessage,
          lastEditedById: this.lastEditedById,
          status: this.status,
          incurredAt: this.incurredAt,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt
        }
      },
      public() {
        return {
          type: TransactionTypes.DEBIT,
          id: this.id,
          UserId: this.UserId,
          CollectiveId: this.CollectiveId,
          currency: this.currency,
          amount: this.amount,
          description: this.description,
          category: this.category,
          payoutMethod: this.payoutMethod,
          vat: this.vat,
          lastEditedById: this.lastEditedById,
          status: this.status,
          incurredAt: this.incurredAt,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt
        }
      }
    },
  });

  /**
   * Instance Methods
   */
  Expense.prototype.setApproved = function(lastEditedById) {
    if (this.status === status.PAID) {
      throw new Error("Can't approve an expense that is PAID");
    }
    this.status = status.APPROVED;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.setRejected = function(lastEditedById) {
    if (this.status === status.PAID) {
      throw new Error("Can't reject an expense that is PAID");
    }
    this.status = status.REJECTED;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.setPaid = function(lastEditedById) {
    this.status = status.PAID;
    this.lastEditedById = lastEditedById;
    return this.save();
  };

  Expense.prototype.getPaypalEmail = function() {
    return this.getUser().then(user => user.paypalEmail || user.email);
  }

  Temporal(Expense, Sequelize);
  return Expense;
}
