/**
 * Socket ownership guards for player actions
 */

function socketOwnsPlayer(room, socketId, playerId) {
  if (!room || !socketId || !playerId) return false;
  const player = room.players?.find(p => p.id === playerId);
  if (!player) return false;
  return player.socketId === socketId;
}

function socketIsHostPlayer(room, socketId, playerId) {
  if (!room || !socketId || !playerId) return false;
  // Host is typically the first player or the one who created the room
  const player = room.players?.find(p => p.id === playerId);
  if (!player) return false;
  
  // Check if this player is the host (first player or has host flag)
  const isHost = room.players[0]?.id === playerId || player.isHost === true;
  
  // And verify the socket owns this player
  return isHost && player.socketId === socketId;
}

module.exports = {
  socketOwnsPlayer,
  socketIsHostPlayer,
};
