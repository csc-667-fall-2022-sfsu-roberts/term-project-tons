const express = require("express");
const router = express.Router();
const passport = require("../middleware/passport");
const Joi = require("joi");
const GlobalChatManager = require("../managers/GlobalChatManager");
const ApiUnauthorizedError = require("../errors/ApiUnauthorizedError");

/**
 * POST /api/global-chat
 * 
 * Request body must be a JSON object containing the keys "message".
 */
router.post("/", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Verify request body has all required properties and has correct format
    const schema = Joi.object({
      message: Joi.string().max(512).required(),
    });
    const validated = await schema.validateAsync(req.body);

    // Send global chat message
    const username = req.user.username;
    const message = validated.message;
    GlobalChatManager.emitGlobalChatMessage(username, message);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});


/**
 * POST /api/global-chat/game-created
 * 
 * Request body must be a JSON object containing the keys "game_id".
 */
router.post("/game-created", passport.session(), async (req, res, next) => {
  try {
    if (!req.user) {
      throw new ApiUnauthorizedError("Not logged in.");
    }

    // Verify request body has all required properties and has correct format
    const schema = Joi.object({
      game_id: Joi.number().integer().required(),
    });
    const validated = await schema.validateAsync(req.body);

    // Send game created message
    const game_id = validated.game_id;
    GlobalChatManager.emitGameCreated(game_id);

    return res.status(200).send();
  } catch(e) {
    next(e);
  }
});

module.exports = router;