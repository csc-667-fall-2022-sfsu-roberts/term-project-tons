const pgp = require("pg-promise");
const db = require("../../db");

class Game {
  constructor(id) {
    this.id = id;
    this.connectedSockets = {};
  }

  async connect(socket) {
    this.connectedSockets[socket.id] = socket;
    socket.on("disconnect", (reason) => {
      delete this.connectedSockets[socket.id];
      console.log(`[Game ${this.id}] Removed socket ID ${socket.id} (${reason}). # of connected sockets: ${Object.keys(this.connectedSockets).length}`);
    });
    console.log(`[Game ${this.id}] Added socket ID ${socket.id}, established by user ${socket.request.session.passport.user.username}. # of connected sockets: ${Object.keys(this.connectedSockets).length}`);

    socket.emit("game_state", await this.getGameStateForUser(socket.request.session.passport.user.user_id));

    this.emitSystemMessage(`"${socket.request.session.passport.user.username}" has joined the game.`);
  }

  /**
   * Emits sanitized game states (cards that the user shouldn't see are hidden) to all connected sockets.
   */
  async emitGameStatesToConnectedSockets() {
    const sanitizedUserGameStates = await this.getGameStatesForConnectedUsers();
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("game_state", sanitizedUserGameStates[this.connectedSockets[socketId].request.session.passport.user.user_id]);
    }
  }

  /**
   * Returns a dictionary of sanitized game states for all connected users/sockets.
   * Should be used when emitting game state to all connected users (eg. after a card is played) instead of ```getGameStateForUser``` to minimize DB queries.
   */
  async getGameStatesForConnectedUsers() {
    const connectedUserIds = Array.from(new Set(Object.values(this.connectedSockets).map(socket => {
      return socket.request.session.passport.user.user_id;
    })));
    const gameState = await this.getGameState();
    const sanitizedUserGameStates = {};
    for (const connectedUserId of connectedUserIds) {
      sanitizedUserGameStates[connectedUserId] = await this.sanitizeGameStateForUser(gameState, connectedUserId);
    }
    return sanitizedUserGameStates;
  }

  /**
   * Returns the sanitized game state (cards that the user shouldn't see are hideen) for a user.
   * This should only be used when emitting game state to a single user (only occurs during initial socket connection).
   */
  async getGameStateForUser(userId) {
    return await this.sanitizeGameStateForUser(await this.getGameState(), userId);
  }

  /**
   * Given a game state and user:
   * Returns a game state where cards that the given user should not be able to see (other player's cards, the deck, etc.) are hidden.
   */
  sanitizeGameStateForUser(gameState, userId) {
    const {
      cards,
      ...restOfGameState
    } = gameState;
    const largestOrderInDiscardPile = cards
      .filter(card => card.location === "DISCARD")
      .reduce((largestOrder, currentCard) => {
        if (!largestOrder || currentCard.order > largestOrder) {
          return currentCard.order;
        } else {
          return largestOrder;
        }
      }, null);
    const sanitizedGameState = {
      cards: cards.map(card => {
        // The user can only see their own cards, and the top card of the discard pile.
        if (card.user_id === userId) {
          return card;
        }
        if (card.location === "DISCARD" && card.order === largestOrderInDiscardPile) {
          return card;
        }
        // Otherwise, the card's card_id (color and value can be determined from card_id), color, and value should be hidden to the user.
        const {
          card_id,
          color,
          value,
          ...restOfCard
        } = card;
        return restOfCard;
      }),
      ...restOfGameState
    };
    return sanitizedGameState;
  }

  /**
   * Retrieves and returns the current game state from DB.
   * The returned game state is unsanitized (all card colors and values are visible).
   */
  async getGameState() {
    // Retrieve game data from DB
    const getGame = new pgp.PreparedStatement({
      name: "get-game",
      text: "SELECT started, ended FROM games WHERE game_id = $1",
    });
    const game = await db.one(getGame, [
      this.id,
    ]);

    const getGameUsers = new pgp.PreparedStatement({
      name: "get-game-users",
      text: "SELECT user_id, username, play_order, state, is_host FROM game_users INNER JOIN users USING(user_id) WHERE game_id = $1",
    });
    const gameUsers = await db.manyOrNone(getGameUsers, [
      this.id,
    ]);

    const getGameCards = new pgp.PreparedStatement({
      name: "get-game-cards",
      text: "SELECT card_id, color, \"value\", location, \"order\", user_id FROM game_cards INNER JOIN cards USING(card_id) WHERE game_id = $1",
    });
    const gameCards = await db.manyOrNone(getGameCards, [
      this.id,
    ]);

    // Construct game state from retrieved data
    const gameState = {
      started: game.started,
      ended: game.ended,
      users: gameUsers,
      cards: gameCards,
    };

    return gameState;
  }

  async shuffleDeck() {
    const shuffleDeckCards = new pgp.PreparedStatement({
      name: "shuffle-deck-cards",
      text: `
        WITH shuffled AS
          (SELECT card_id, ROW_NUMBER() OVER(ORDER BY RANDOM()) - 1 AS new_order
            FROM game_cards
            WHERE game_id = $1 AND location = 'DECK')
        UPDATE game_cards
          SET \"order\" = new_order FROM shuffled
          WHERE game_id = $1 AND location = 'DECK' AND game_cards.card_id = shuffled.card_id`,
    });
    await db.none(shuffleDeckCards, [
      this.id,
    ]);
  }

  /**
   * Emits a chat message event to all connected sockets.
   */
  emitChatMessage(username, message) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("chat_message", { username: username, message: message });
    }
  }

  emitSystemMessage(message) {
    for (const socketId in this.connectedSockets) {
      this.connectedSockets[socketId].emit("system_message", { message: message });
    }
  }
}

module.exports = Game;