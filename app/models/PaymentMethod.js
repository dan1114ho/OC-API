module.exports = function(Sequelize, DataTypes) {

  var PaymentMethod = Sequelize.define('PaymentMethod', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    number: DataTypes.STRING, // Delete #postmigration
    token: DataTypes.STRING,
    customerId: DataTypes.STRING, // stores the id of the customer from the payment processor
    service: {
      type: DataTypes.STRING,
      defaultValue: 'stripe'
    },
    data: DataTypes.JSON,
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: Sequelize.NOW
    },
    confirmedAt: {
      type: DataTypes.DATE
    },
    UserId: {
      type: DataTypes.INTEGER,
      references: 'Users',
      referencesKey: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    },
  }, {
    paranoid: true,

    getterMethods: {
      // Info.
      info: function() {
        return {
          id: this.id,
          token: this.token,
          service: this.service,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          confirmedAt: this.confirmedAt
        };
      }
    },

    classMethods: {
      // Note we can't use findOrCreate() method in Sequelize because of
      // https://github.com/sequelize/sequelize/issues/4631
      getOrCreate: (params) => {
        const token = params.token;
        const service = params.service;
        const UserId = params.UserId;

        return PaymentMethod.findOne({
          where: {
            token,
            service,
            UserId: UserId
          }
        })
        .then(paymentMethod => {
          if (!paymentMethod) {
            return PaymentMethod.create({
              token,
              service,
              UserId
            });
          } else {
            return paymentMethod;
          }
        });
      }
    }
  });

  return PaymentMethod;
};
