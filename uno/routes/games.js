const express = require("express");
const router = express.Router();
const Joi = require("joi");
const passport = require("../middleware/passport");
const GameManager = require("../managers/GameManager");
const ApiNotFoundError = require("../errors/ApiNotFoundError");
const ApiUnauthorizedError = require("../errors/ApiUnauthorizedError");

/**
 * POST /api/games
 * 
 * Creates a new game.
 */
router.post("/", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Create game
    const hostUserId = req.user.user_id;
    const newGameId = await GameManager.createNewGame(hostUserId);

    return res.status(200).json({
      game_id: newGameId,
    });
  } catch(e) {
    next(e);
  }
});

/**
 * POST /api/games/:gameId/chat
 * 
 * Request body must be a JSON object containing the keys "message".
 * Sends a chat message to a game.
 */
router.post("/:gameId/chat", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Verify request body has all required properties and has correct format
    const schema = Joi.object({
      message: Joi.string().max(512).required(),
    });
    const validated = await schema.validateAsync(req.body);

    // Retrieve game instance
    const game = await GameManager.getGameByGameId(req.params.gameId);
    if (!game) {
      throw new ApiNotFoundError(`Game with ID '${req.params.gameId}' does not exist.`);
    }

    // Send chat message
    await game.emitChatMessage(req.user.username, validated.message);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

module.exports = router;