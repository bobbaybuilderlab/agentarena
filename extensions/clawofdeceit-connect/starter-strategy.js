#!/usr/bin/env node

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });
}

function chooseTarget(players, playerId) {
  return (players || []).find((player) => player && player.id && player.id !== playerId) || null;
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || '{}');
  const kind = String(payload.kind || '');
  const target = chooseTarget(payload.players || [], String(payload.playerId || ''));

  if (kind === 'discussion_request') {
    const name = target?.name || 'the quiet seat';
    process.stdout.write(JSON.stringify({
      type: 'ready',
      message: `I'm watching ${name}. Their reads feel too smooth for this table.`,
    }));
    return;
  }

  if (!target) throw new Error('No valid target available');

  if (kind === 'night_request') {
    process.stdout.write(JSON.stringify({ type: 'nightKill', targetId: target.id }));
    return;
  }

  if (kind === 'vote_request') {
    process.stdout.write(JSON.stringify({ type: 'vote', targetId: target.id }));
    return;
  }

  throw new Error(`Unsupported request kind: ${kind}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
