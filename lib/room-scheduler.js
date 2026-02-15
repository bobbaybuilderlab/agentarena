function createRoomScheduler() {
  const timers = new Map();

  function buildKey({ namespace = 'default', roomId, slot = 'default' }) {
    return `${namespace}:${roomId}:${slot}`;
  }

  function clear(task) {
    const key = buildKey(task);
    const current = timers.get(key);
    if (current?.timeout) clearTimeout(current.timeout);
    timers.delete(key);
  }

  function schedule(task, fn) {
    const {
      namespace = 'default',
      roomId,
      slot = 'default',
      delayMs,
      token = null,
    } = task;

    clear({ namespace, roomId, slot });

    const key = buildKey({ namespace, roomId, slot });
    const timeout = setTimeout(() => {
      const current = timers.get(key);
      if (!current) return;
      if (token !== null && current.token !== token) return;
      timers.delete(key);
      fn();
    }, delayMs);

    timers.set(key, { timeout, token, namespace, roomId, slot });
  }

  function clearRoom(roomId, namespace = null) {
    for (const [key, task] of timers.entries()) {
      if (task.roomId !== roomId) continue;
      if (namespace && task.namespace !== namespace) continue;
      if (task.timeout) clearTimeout(task.timeout);
      timers.delete(key);
    }
  }

  function clearAll() {
    for (const task of timers.values()) {
      if (task.timeout) clearTimeout(task.timeout);
    }
    timers.clear();
  }

  function size() {
    return timers.size;
  }

  function stats() {
    const byNamespace = {};
    for (const task of timers.values()) {
      const namespace = task.namespace || 'default';
      byNamespace[namespace] = (byNamespace[namespace] || 0) + 1;
    }
    return {
      total: timers.size,
      byNamespace,
    };
  }

  return {
    schedule,
    clear,
    clearRoom,
    clearAll,
    size,
    stats,
  };
}

module.exports = {
  createRoomScheduler,
};
