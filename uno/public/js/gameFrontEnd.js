import { CARD_FILE } from './resources.js';

const searchParams = new URLSearchParams(window.location.search);
const gameId = searchParams.get('game_id');
const message_container = document.querySelector('.chat-field');
const messageButton = document.querySelector('.input-button');
const input = document.querySelector('.input-field-chat');
const wildcardButtonContainer = document.querySelector(
  '.wildcardButtonContainer'
);

const socket = io({
  path: '/games/',
  query: {
    game_id: gameId,
  },
});

// GCHAT functions
messageButton.addEventListener('click', addMessage);
socket.on('chat_message', (data) => {
  message_container.innerHTML += createContainer(data.username, data.message);
});

function addMessage() {
  if (input.value === '') {
    return;
  } else {
    var message = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        message: input.value,
      }),
    };
    fetch(`/api/games/${gameId}/chat`, message).catch((err) =>
      console.log(err)
    );
    input.value = '';
    input.focus();
  }
}

function createContainer(username, message) {
  return `
  <div class="row comments mb-2">
  <div class="col-md-2 col-sm-2 col-3 text-center user-img">
  <p>&nbsp</p>
  </div>
  <div class="col-md-9 col-sm-9 col-9 comment rounded mb-2">
  <h4 class="m-0"><a href="#">${username}</a></h4>
  <time class="text-white ml-3"></time>
  <like></like>
  <p class="mb-0 text-white">${message}</p>
  </div>
  </div>
  
  `;
}

//  GAME STATE
const gamePlayers = {
  leftOpponent: '',
  topOpponent: '',
  rightOpponent: '',
};

let discardPileDegree = [];
for (let i = 0; i < 108; i++) {
    discardPileDegree.push(Math.floor(Math.random() * 20) * (Math.round(Math.random()) ? 1 : -1));
}

let currentUser;
fetch('/api/users/current').then((response) => {
  if (response.status == 200) {
    response.json().then((data) => {
      currentUser = data.user;
      console.log(currentUser);
    });
  } else {
    alert('Not logged in');
  }
});


socket.on("game_state", (gameState) => {
    console.log(gameState)
    //small issue with play order, if the player refreshes then the
    const currentOpponents = gameState?.users.filter(opponent => {
        return opponent.user_id !== currentUser.user_id;
    }).sort((a, b) => a.play_order - b.play_order);

    for (let opponent of currentOpponents) {
        if (!gamePlayers[opponent]) {
            Object.keys(gamePlayers).forEach(key => {
                if (gamePlayers[key] === "") {
                    gamePlayers[key] = opponent;
                }
            });
        }
    }


    const deleteAssets = document.getElementById("myHand")

    while (deleteAssets.firstChild) {
        deleteAssets.removeChild(deleteAssets.firstChild);
    }
    const currentUserCards = gameState?.cards.filter(card => {
        return card.user_id === currentUser.user_id;
    }).sort((a, b) => a.order - b.order);
    for (const card of currentUserCards) {
        // dealCard(CARD_FILE[card.color][card.value]); -- change by troy
        dealCard(card)
    }

    Object.keys(gamePlayers).forEach(key => {
        if (gamePlayers[key] !== "") {
            const currentOpponentCards = gameState?.cards.filter(card => {
                return card.user_id === gamePlayers[key];
            })
            for (const card of currentOpponentCards) {
                dealOpponentCard(Object.keys(gamePlayers).find(key => object[key] === value));
            }
        }
    });

    const discardPile = gameState?.cards.filter(card => {
        return card.location === "DISCARD"
    }).sort((a, b) => a.order - b.order);

    discardPileCard(discardPile);



});

socket.on('game_event', (gameEvent) => {
    console.log(gameEvent)
    switch (gameEvent.type) {
        //Additional keys: user_id
        case "PLAYER_JOINED":
            break;
        //Additional keys: user_id
        case "PLAYER_LEFT":
            break;
        case "PLAYER_FORFEIT":
            break;
        case "DECK_SHUFFLED":
            replenishDeck();
            break;
        //Additional keys: user_id
        case "DEALT_CARD":
            visualizeDealtCard(gameEvent?.user_id);
            break;
        case "GAME_DELETED":
            //?? what do we display here
            // TODO: display message "the host has ended the game", redirect to lobby
            break;
        case "GAME_STARTED":
            //TODO
            //make 
            break;
        case "GAME_ENDED":
            break;
        case "CARD_PLAYED":
            break;
        default:
            console.log("Unrecognized ")
    }
})

//TODO
//direction of play matters
function addPlayer(user_id) {
  for (const opponent in gamePlayers) {
    if (!gamePlayers[opponent]) {
      gamePlayers[opponent] = user_id;
      break;
    }
  }
}

function removePlayer(user_id) {
  for (const opponent in gamePlayers) {
    if (gamePlayers[opponent] === user_id) {
      gamePlayers[opponent] = '';
      break;
    }
  }
}

let lastDeckCard;
replenishDeck();

//TODO
//get number of cards reshuffled (maybe from DECK_RESHUFFLED io event)
function replenishDeck(deckSize) {
  if (!deckSize) {
    deckSize = 80;
    //TODO
    //based on 7 cards dealt to FOUR players
    //get number of players? or localize a value
  }

  for (let i = 0; i < deckSize; i++) {
    let elem = document.getElementsByClassName('deckContainer').item(0);
    let newCard = document.createElement('div');
    newCard.classList.add('card', 'deckCard');
    elem.appendChild(newCard);
  }
  lastDeckCard = document
    .getElementsByClassName('deckContainer')
    .item(0).lastChild;
  lastDeckCard.addEventListener('click', takeAndDeal, false);
}

function takeAndDeal() {
  lastDeckCard.remove();
  lastDeckCard = document
    .getElementsByClassName('deckContainer')
    .item(0).lastChild;
  dealCard();
  lastDeckCard.addEventListener('click', takeAndDeal, false);
}

/**
 *             | |
 *             | |
 *             | |
 *            \   /
 *              ∨
 */

function dealCard(card) {

  let elem = document.getElementById('myHand');
  let newCard = document.createElement('div');
  newCard.classList.add('card', 'myCard');
  newCard.setAttribute('id', `${card.card_id}`);
  newCard.style.backgroundImage =
    'url(' + CARD_FILE[card.color][card.value] + ')';
  if (card.color === 'BLACK') {
    newCard.addEventListener(
      'click',
      function () {
        window.location.href = '#modal';
        wildcard(newCard);
      },
      false
    );
  } else {
    newCard.addEventListener(
      'click',
      function () {
        playCard(newCard, null);
      },
      false
    );
  }
  elem.appendChild(newCard);
}

function dealOpponentCard(user_id) {
  const key = Object.keys(gamePlayers).find(
    (user_id) => obj[user_id] === value
  );
  const elem = getElementById(key);
  let newCard = document.createElement('div');
  newCard.classList.add('card', key + 'card');
}

/**
 *             | |
 *             | |
 *             | |
 *            \   /
 *              ∨
 */

//TODO
//add timeout to play another card
function playCard(elem, color) {
  //TODO
  const num = parseInt(elem.id);
  const query = `/api/games/${gameId}/play-card`;

  let request;

  if (color != null) {
    while (wildcardButtonContainer.firstChild) {
      wildcardButtonContainer.removeChild(wildcardButtonContainer.firstChild);
    }
    request = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        card_id: num,
        chosen_wildcard_color: color,
      }),
    };
  } else {
    request = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        card_id: num,
      }),
    };
  }

  fetch(query, request);
}

function wildcard(card) {
  const redButton = document.getElementById('redbttn');
  const blueButton = document.getElementById('bluebttn');
  const yellowButton = document.getElementById('yellowbttn');
  const greenButton = document.getElementById('greenbttn');

  redButton.addEventListener('click', function () {
    console.log('RED picked');
    playCard(card, 'RED');
    window.location.href = '#';
  });
  blueButton.addEventListener('click', function () {
    console.log('BLUE picked');
    playCard(card, 'BLUE');
    window.location.href = '#';
  });
  yellowButton.addEventListener('click', function () {
    console.log('YELLOW picked');
    playCard(card, 'YELLOW');
    window.location.href = '#';
  });
  greenButton.addEventListener('click', function () {
    console.log('GREEN picked');
    playCard(card, 'GREEN');
    window.location.href = '#';
  });
}

/**
 *             | |
 *             | |
 *             | |
 *            \   /
 *              ∨
 */

function discardPileCard(discardPile) {
    let degreeTracker = 0;
    for (const card of discardPile) {
        let elem = document.getElementsByClassName("discard").item(0);
        let newCard = document.createElement("div");
        elem.appendChild(newCard);
        newCard.classList.add("card", "discardCard");
        newCard.style.backgroundImage = "url(" + CARD_FILE[card.color][card.value] + ")";
        newCard.style.transform = 'rotate(calc(' + discardPileDegree[degreeTracker] + 'deg' + '))'
        degreeTracker++;
    }
    let lastCard = document.getElementsByClassName("discard").item(0).lastChild;
    lastCard.animate([
        { transform: 'rotate(calc(' + discardPileDegree[degreeTracker] + 'deg' + ')) scale(1.5)' },
        { transform: 'rotate(calc(' + discardPileDegree[degreeTracker] + 'deg' + ')) scale(1)' }
    ], {
        duration: 300,
        iterations: 1
    })
    lastCard.style.transform = 'rotate(calc(' + discardPileDegree[degreeTracker] + 'deg' + '))'
}
