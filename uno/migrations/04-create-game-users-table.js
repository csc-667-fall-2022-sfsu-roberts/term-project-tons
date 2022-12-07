"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("game_users", {
      game_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: {
          model: "games",
          key: "game_id",
        },
      },
      user_id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        allowNull: false,
        references: {
          model: "users",
          key: "user_id",
        },
      },
      play_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      seat_order: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      state: {
        type: Sequelize.ENUM("PLAYING", "WON", "LOST"),
        allowNull: false,
      },
      is_host: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
      },
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("game_users");
  }
};