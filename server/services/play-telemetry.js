function createPlayTelemetryService({
  playRoomTelemetry,
  pendingQuickJoinTickets,
  reconnectClaimTickets,
  roomEvents,
  shortId,
  getClaimableLobbySeats,
}) {
  const RECONNECT_TICKET_TTL_MS = 30 * 60 * 1000;

  function telemetryKey(mode, roomId) {
    return `${mode}:${String(roomId || '').toUpperCase()}`;
  }

  function getRoomTelemetry(mode, roomId) {
    const key = telemetryKey(mode, roomId);
    if (!playRoomTelemetry.has(key)) {
      playRoomTelemetry.set(key, {
        mode,
        roomId: String(roomId || '').toUpperCase(),
        rematchCount: 0,
        partyStreakExtended: 0,
        telemetryEvents: {
          rematch_clicked: 0,
          party_streak_extended: 0,
        },
        recentWinners: [],
        quickMatchTickets: 0,
        quickMatchConversions: 0,
        reconnectAutoAttempts: 0,
        reconnectAutoSuccesses: 0,
        reconnectAutoFailures: 0,
        reclaimClicked: 0,
        quickRecoverClicked: 0,
        joinAttempts: 0,
        socketSeatCapBlocked: 0,
        updatedAt: Date.now(),
      });
    }
    return playRoomTelemetry.get(key);
  }

  function recordRoomWinner(mode, room) {
    if (!room?.id || !room?.winner || room.status !== 'finished') return;
    const telemetry = getRoomTelemetry(mode, room.id);
    const winnerName = room.players?.find((p) => p.role === room.winner)?.name || room.winner;
    const latest = telemetry.recentWinners[telemetry.recentWinners.length - 1];
    if (latest && latest.winner === room.winner && Date.now() - latest.at < 1_000) return;
    telemetry.recentWinners.push({ winner: room.winner, winnerName, at: Date.now() });
    telemetry.recentWinners = telemetry.recentWinners.slice(-5);
    telemetry.updatedAt = Date.now();
  }

  function recordTelemetryEvent(mode, roomId, eventName) {
    const telemetry = getRoomTelemetry(mode, roomId);
    if (!telemetry.telemetryEvents || typeof telemetry.telemetryEvents !== 'object') {
      telemetry.telemetryEvents = { rematch_clicked: 0, party_streak_extended: 0 };
    }
    telemetry.telemetryEvents[eventName] = Math.max(0, Number(telemetry.telemetryEvents[eventName] || 0)) + 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function recordRematch(mode, roomId) {
    const telemetry = getRoomTelemetry(mode, roomId);
    telemetry.rematchCount += 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function quickJoinTicketKey(mode, roomId, name) {
    return `${telemetryKey(mode, roomId)}:${String(name || '').trim().toLowerCase()}`;
  }

  function issueQuickJoinTicket(mode, roomId, name) {
    const telemetry = getRoomTelemetry(mode, roomId);
    telemetry.quickMatchTickets += 1;
    telemetry.updatedAt = Date.now();
    pendingQuickJoinTickets.set(quickJoinTicketKey(mode, roomId, name), Date.now());
  }

  function recordQuickJoinConversion(mode, roomId, name) {
    const key = quickJoinTicketKey(mode, roomId, name);
    if (!pendingQuickJoinTickets.has(key)) return;
    pendingQuickJoinTickets.delete(key);
    const telemetry = getRoomTelemetry(mode, roomId);
    telemetry.quickMatchConversions += 1;
    telemetry.updatedAt = Date.now();
    roomEvents.append('growth', roomId, 'QUICK_JOIN_CONVERTED', { mode, name: String(name || '').slice(0, 24) });
  }

  function recordReconnectAutoTelemetry(mode, roomId, outcome) {
    const telemetry = getRoomTelemetry(mode, roomId);
    if (outcome === 'attempt') telemetry.reconnectAutoAttempts += 1;
    else if (outcome === 'success') telemetry.reconnectAutoSuccesses += 1;
    else if (outcome === 'failure') telemetry.reconnectAutoFailures += 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function recordReconnectClickTelemetry(mode, roomId, event) {
    const telemetry = getRoomTelemetry(mode, roomId);
    if (event === 'reclaim_clicked') telemetry.reclaimClicked += 1;
    else if (event === 'quick_recover_clicked') telemetry.quickRecoverClicked += 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function recordJoinAttempt(mode, roomId) {
    const telemetry = getRoomTelemetry(mode, roomId);
    telemetry.joinAttempts += 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function recordSocketSeatCapBlocked(mode, roomId) {
    const telemetry = getRoomTelemetry(mode, roomId);
    telemetry.socketSeatCapBlocked += 1;
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function reconnectTicketKey(mode, roomId, token) {
    return `${telemetryKey(mode, roomId)}:${String(token || '').trim()}`;
  }

  function sweepExpiredReconnectClaimTickets(now = Date.now()) {
    for (const [key, ticket] of reconnectClaimTickets.entries()) {
      if ((now - Number(ticket?.issuedAt || 0)) > RECONNECT_TICKET_TTL_MS) {
        reconnectClaimTickets.delete(key);
      }
    }
  }

  function issueReconnectClaimTicket(mode, roomId, name) {
    const now = Date.now();
    sweepExpiredReconnectClaimTickets(now);
    const token = shortId(16);
    reconnectClaimTickets.set(reconnectTicketKey(mode, roomId, token), {
      name: String(name || '').trim(),
      issuedAt: now,
    });
    return token;
  }

  function readReconnectClaimTicket(mode, roomId, token, consume = false) {
    const now = Date.now();
    sweepExpiredReconnectClaimTickets(now);
    const key = reconnectTicketKey(mode, roomId, token);
    const found = reconnectClaimTickets.get(key);
    if (!found) return null;
    if ((now - Number(found.issuedAt || 0)) > RECONNECT_TICKET_TTL_MS) {
      reconnectClaimTickets.delete(key);
      return null;
    }
    if (consume) reconnectClaimTickets.delete(key);
    return found;
  }

  function consumeReconnectClaimTicket(mode, roomId, token) {
    return readReconnectClaimTicket(mode, roomId, token, true);
  }

  function resolveReconnectJoinName(mode, roomId, requestedName, claimToken) {
    const normalizedRequested = String(requestedName || '').trim();
    const claims = getClaimableLobbySeats(mode, roomId);
    if (!claims.ok || !Array.isArray(claims.claimable) || !claims.claimable.length) {
      return { name: normalizedRequested, suggested: null, consumedClaimToken: null };
    }

    const lowerRequested = normalizedRequested.toLowerCase();
    const direct = claims.claimable.find((seat) => seat.name.toLowerCase() === lowerRequested) || null;
    if (direct) return { name: direct.name, suggested: direct.name, consumedClaimToken: null };

    const ticket = claimToken ? readReconnectClaimTicket(mode, roomId, claimToken, false) : null;
    if (ticket?.name) {
      const matched = claims.claimable.find((seat) => seat.name.toLowerCase() === ticket.name.toLowerCase());
      if (matched) return { name: matched.name, suggested: matched.name, consumedClaimToken: claimToken };
    }

    return { name: normalizedRequested, suggested: null, consumedClaimToken: null };
  }

  function pickReconnectSuggestion(mode, roomId, requestedName) {
    const claims = getClaimableLobbySeats(mode, roomId);
    if (!claims.ok || !Array.isArray(claims.claimable) || !claims.claimable.length) return null;

    const preferredByName = claims.claimable.find((seat) => seat.name.toLowerCase() === String(requestedName || '').trim().toLowerCase());
    const preferred = preferredByName || claims.claimable.find((seat) => seat.hostSeat) || claims.claimable[0];
    if (!preferred?.name) return null;

    const token = issueReconnectClaimTicket(mode, roomId, preferred.name);
    return { name: preferred.name, hostSeat: Boolean(preferred.hostSeat), token };
  }

  function seedPlayTelemetry(mode, roomId, patch = {}) {
    const telemetry = getRoomTelemetry(mode, roomId);
    if (!patch || typeof patch !== 'object') return telemetry;

    if (Number.isFinite(patch.rematchCount)) telemetry.rematchCount = Math.max(0, Number(patch.rematchCount));
    if (Number.isFinite(patch.partyStreakExtended)) telemetry.partyStreakExtended = Math.max(0, Number(patch.partyStreakExtended));
    if (Number.isFinite(patch.quickMatchTickets)) telemetry.quickMatchTickets = Math.max(0, Number(patch.quickMatchTickets));
    if (Number.isFinite(patch.quickMatchConversions)) {
      telemetry.quickMatchConversions = Math.max(0, Number(patch.quickMatchConversions));
    }
    if (Number.isFinite(patch.reconnectAutoAttempts)) {
      telemetry.reconnectAutoAttempts = Math.max(0, Number(patch.reconnectAutoAttempts));
    }
    if (Number.isFinite(patch.reconnectAutoSuccesses)) {
      telemetry.reconnectAutoSuccesses = Math.max(0, Number(patch.reconnectAutoSuccesses));
    }
    if (Number.isFinite(patch.reconnectAutoFailures)) {
      telemetry.reconnectAutoFailures = Math.max(0, Number(patch.reconnectAutoFailures));
    }
    if (Number.isFinite(patch.reclaimClicked)) {
      telemetry.reclaimClicked = Math.max(0, Number(patch.reclaimClicked));
    }
    if (Number.isFinite(patch.quickRecoverClicked)) {
      telemetry.quickRecoverClicked = Math.max(0, Number(patch.quickRecoverClicked));
    }
    if (Number.isFinite(patch.joinAttempts)) {
      telemetry.joinAttempts = Math.max(0, Number(patch.joinAttempts));
    }
    if (Number.isFinite(patch.socketSeatCapBlocked)) {
      telemetry.socketSeatCapBlocked = Math.max(0, Number(patch.socketSeatCapBlocked));
    }
    if (patch.telemetryEvents && typeof patch.telemetryEvents === 'object') {
      telemetry.telemetryEvents = {
        rematch_clicked: Math.max(0, Number(patch.telemetryEvents.rematch_clicked || 0)),
        party_streak_extended: Math.max(0, Number(patch.telemetryEvents.party_streak_extended || 0)),
      };
    }
    if (Array.isArray(patch.recentWinners)) {
      telemetry.recentWinners = patch.recentWinners.slice(-5);
    }
    telemetry.updatedAt = Date.now();
    return telemetry;
  }

  function resetPlayTelemetry() {
    playRoomTelemetry.clear();
    pendingQuickJoinTickets.clear();
    reconnectClaimTickets.clear();
  }

  return {
    telemetryKey,
    getRoomTelemetry,
    recordRoomWinner,
    recordTelemetryEvent,
    recordRematch,
    issueQuickJoinTicket,
    recordQuickJoinConversion,
    recordReconnectAutoTelemetry,
    recordReconnectClickTelemetry,
    recordJoinAttempt,
    recordSocketSeatCapBlocked,
    consumeReconnectClaimTicket,
    resolveReconnectJoinName,
    pickReconnectSuggestion,
    seedPlayTelemetry,
    resetPlayTelemetry,
  };
}

module.exports = {
  createPlayTelemetryService,
};
