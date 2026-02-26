function socketOwnsPlayer(room, socketId, playerId) {
  const player = room?.players?.find((p) => p.id === playerId);
  return Boolean(player && player.socketId && player.socketId === socketId);
}

function socketIsHostPlayer(room, socketId, playerId) {
  if (!room || !playerId) return false;
  return room.hostPlayerId === playerId && socketOwnsPlayer(room, socketId, playerId);
}

module.exports = {
  socketOwnsPlayer,
  socketIsHostPlayer,
};
