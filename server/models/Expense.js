const status = require('../constants/expense_status');
const type = require('../constants/transactions').type.EXPENSE;
const allowedCurrencies = Object.keys(require('../constants/currencies'));

module.exports = function (Sequelize, DataTypes) {

  return Sequelize.define('Expense', {
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

    GroupId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Groups',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false
    },

    currency: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [allowedCurrencies],
          msg: `Must be in ${allowedCurrencies}`
        }
      },
      allowNull: false
    },

    amount: {
      type: DataTypes.INTEGER,
      validate: { min: 1 },
      allowNull: false
    },

    title: {
      type: DataTypes.STRING,
      allowNull: false
    },

    payoutMethod: {
      type: DataTypes.STRING,
      validate: {
        isIn: {
          args: [['paypal', 'manual', 'other']],
          msg: 'Must be paypal, manual or other'
        }
      },
      allowNull: false,
      defaultValue: 'manual'
    },

    notes: DataTypes.TEXT,
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
          type,
          id: this.id,
          UserId: this.UserId,
          GroupId: this.GroupId,
          currency: this.currency,
          amount: this.amount,
          title: this.title,
          attachment: this.attachment,
          category: this.category,
          payoutMethod: this.payoutMethod,
          vat: this.vat,
          notes: this.notes,
          lastEditedById: this.lastEditedById,
          status: this.status,
          incurredAt: this.incurredAt,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt
        }
      }
    },

    instanceMethods: {
      setApproved() {
        this.status = status.APPROVED;
        return this.save();
      },

      setRejected() {
        this.status = status.REJECTED;
        return this.save();
      },

      setPaid() {
        this.status = status.PAID;
        return this.save();
      }
    }
  });
};
