import fs from "fs";
import pathfinding from "pathfinding";
import { Server } from "socket.io";
import { MongoClient } from "mongodb";
import express from "express";
import bodyParser from "body-parser";
import cors from 'cors'; // Import cors
import https from "https";


// Load SSL certificates
const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/starkshoot.fun/privkey.pem'),  // Replace with your SSL key path
  cert: fs.readFileSync('/etc/letsencrypt/live/starkshoot.fun/fullchain.pem') // Replace with your SSL certificate path
  ///etc/letsencrypt/live/starkshoot.fun/fullchain.pem
};

// MongoDB setup
const uri = "mongodb+srv://nagi:nagi@cluster0.ohv5gsc.mongodb.net/";
const client = new MongoClient(uri);
let db;

// Connect to MongoDB
async function connectToDB() {
  try {
    await client.connect();
    db = client.db("gameDatabase");
    console.log("Connected to MongoDB and loading world...");
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}

// Call this function to ensure DB connection on start
connectToDB();

// Setup express app
const app = express();
app.use(bodyParser.json());
app.use(cors());

const origin = "*";

// Create an HTTPS server with your certificates
const server = https.createServer(options, app);

// Attach Socket.IO to the HTTPS server
const io = new Server(server, {
  cors: {
    origin,
  },
});

console.log("Server started on port 3000, allowed CORS origin: " + origin);

// PATHFINDING UTILS

const finder = new pathfinding.AStarFinder({
  allowDiagonal: true,
  dontCrossCorners: true,
});

const findPath = (room, start, end) => {
  const gridClone = room.grid.clone();
  const path = finder.findPath(start[0], start[1], end[0], end[1], gridClone);
  return path;
};

const updateGrid = (room) => {
  for (let x = 0; x < room.size[0] * room.gridDivision; x++) {
    for (let y = 0; y < room.size[1] * room.gridDivision; y++) {
      room.grid.setWalkableAt(x, y, true);
    }
  }

  room.items.forEach((item) => {
    if (item.walkable || item.wall) {
      return;
    }
    const width =
      item.rotation === 1 || item.rotation === 3 ? item.size[1] : item.size[0];
    const height =
      item.rotation === 1 || item.rotation === 3 ? item.size[0] : item.size[1];
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        room.grid.setWalkableAt(
          item.gridPosition[0] + x,
          item.gridPosition[1] + y,
          false
        );
      }
    }
  });
};

// ROOMS MANAGEMENT
const rooms = [];

const loadRooms = async () => {
  let data;
  try {
    data = fs.readFileSync("rooms.json", "utf8");
  } catch (ex) {
    console.log("No rooms.json file found, using default file");
    try {
      data = fs.readFileSync("default.json", "utf8");
    } catch (ex) {
      console.log("No default.json file found, exiting");
      process.exit(1);
    }
  }
  data = JSON.parse(data);
  data.forEach((roomItem) => {
    const room = {
      ...roomItem,
      size: [7, 7], // HARDCODED FOR SIMPLICITY PURPOSES
      gridDivision: 2,
      characters: [],
    };
    room.grid = new pathfinding.Grid(
      room.size[0] * room.gridDivision,
      room.size[1] * room.gridDivision
    );
    updateGrid(room);
    rooms.push(room);
  });
};

loadRooms();

// UTILS

const generateRandomPosition = (room) => {
  for (let i = 0; i < 100; i++) {
    const x = Math.floor(Math.random() * room.size[0] * room.gridDivision);
    const y = Math.floor(Math.random() * room.size[1] * room.gridDivision);
    if (room.grid.isWalkableAt(x, y)) {
      return [x, y];
    }
  }
};

// SOCKET MANAGEMENT

io.on("connection", (socket) => {
  try {
    let room = null;
    let character = null;

    socket.emit("welcome", {
      rooms: rooms.map((room) => ({
        id: room.id,
        name: room.name,
        nbCharacters: room.characters.length,
      })),
      items,
    });

    socket.on("joinRoom", (roomId, opts) => {
      room = rooms.find((room) => room.id === roomId);
      if (!room) {
        return;
      }
      socket.join(room.id);
      character = {
        id: socket.id,
        session: parseInt(Math.random() * 1000),
        position: generateRandomPosition(room),
        avatarUrl: opts.avatarUrl,
      };
      room.characters.push(character);

      socket.emit("roomJoined", {
        map: {
          gridDivision: room.gridDivision,
          size: room.size,
          items: room.items,
        },
        characters: room.characters,
        id: socket.id,
      });
      onRoomUpdate();
    });

    const onRoomUpdate = () => {
      io.to(room.id).emit("characters", room.characters);
      io.emit(
        "rooms",
        rooms.map((room) => ({
          id: room.id,
          name: room.name,
          nbCharacters: room.characters.length,
        }))
      );
    };

    socket.on("leaveRoom", () => {
      if (!room) {
        return;
      }
      socket.leave(room.id);
      room.characters.splice(
        room.characters.findIndex((character) => character.id === socket.id),
        1
      );
      onRoomUpdate();
      room = null;
    });

    socket.on("characterAvatarUpdate", (avatarUrl) => {
      character.avatarUrl = avatarUrl;
      io.to(room.id).emit("characters", room.characters);
    });

    socket.on("move", (from, to) => {
      const path = findPath(room, from, to);
      if (!path) {
        return;
      }
      character.position = from;
      character.path = path;
      io.to(room.id).emit("playerMove", character);
    });

    socket.on("dance", () => {
      io.to(room.id).emit("playerDance", {
        id: socket.id,
      });
    });

    socket.on("chatMessage", (message) => {
      io.to(room.id).emit("playerChatMessage", {
        id: socket.id,
        message,
      });
    });

    socket.on("passwordCheck", (password) => {
      if (password === room.password) {
        socket.emit("passwordCheckSuccess");
        character.canUpdateRoom = true;
      } else {
        socket.emit("passwordCheckFail");
      }
    });

    socket.on("itemsUpdate", async (items) => {
      if (!character.canUpdateRoom) {
        return;
      }
      if (!items || items.length === 0) {
        return; // security
      }
      room.items = items;
      updateGrid(room);
      room.characters.forEach((character) => {
        character.path = [];
        character.position = generateRandomPosition(room);
      });
      io.to(room.id).emit("mapUpdate", {
        map: {
          gridDivision: room.gridDivision,
          size: room.size,
          items: room.items,
        },
        characters: room.characters,
      });

      fs.writeFileSync("rooms.json", JSON.stringify(rooms, null, 2));
    });

    socket.on("disconnect", () => {
      console.log("User disconnected");
      if (room) {
        room.characters.splice(
          room.characters.findIndex((character) => character.id === socket.id),
          1
        );
        onRoomUpdate();
        room = null;
      }
    });
  } catch (ex) {
    console.log(ex);
  }
});

// SHOP ITEMS
const items = {
  washer: {
    name: "washer",
    size: [2, 2],
  },
  toiletSquare: {
    name: "toiletSquare",
    size: [2, 2],
  }
};

// Express API for storing avatar models into MongoDB

// Store avatar model for a player
app.post("/api/store-avatar", async (req, res) => {
  const { player_id, model_url } = req.body;

  if (!player_id || !model_url) {
    return res.status(400).json({ message: 'Missing player_id or model_url.' });
  }

  try {
    const collection = db.collection("avatars");

    // Store the model URL for the player
    await collection.updateOne(
      { player_id }, // Find by player_id
      { $set: { model_url, updatedAt: new Date() } }, // Update the model_url and timestamp
      { upsert: true } // If the document doesn't exist, create it
    );

    res.status(200).json({ message: "Model URL stored successfully." });
  } catch (err) {
    console.error("Error storing model URL:", err);
    res.status(500).json({ message: "Error storing model URL.", error: err });
  }
});

// Retrieve the last model URL by player_id
app.get("/api/get-avatar/:player_id", async (req, res) => {
  const player_id = req.params.player_id;

  try {
    const collection = db.collection("avatars");

    // Retrieve the most recent model URL for the player
    const playerData = await collection.findOne({ player_id });

    if (playerData) {
      res.status(200).json({ model_url: playerData.model_url });
    } else {
      res.status(404).json({ message: "No model found for the specified player_id." });
    }
  } catch (err) {
    console.error("Error retrieving model URL:", err);
    res.status(500).json({ message: "Error retrieving model URL.", error: err });
  }
});




app.get("/health",(req, res) => {
  return res.status(200).json({status:"good"})
})


// io.listen(3000);
// console.log("Socket.IO server started on port 3000 with HTTPS, allowed CORS origin: " + origin);


// [Your existing Socket.IO code and API routes go here]

// Start the Express server on HTTPS
// server.listen(3000, () => {
//   console.log(`HTTPS Express server started on port ${PORT}`);
// });

server.listen(2053, '0.0.0.0', () => {
  console.log("Secure server started on port 2053");
});


const PORT = process.env.PORT || 2054;
app.listen(PORT, () => {
  console.log(`Express server started on port ${PORT}`);
});