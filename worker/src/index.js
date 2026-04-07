/**
 * 예약: POST /api/bookings (고객)
 * 목록: GET /api/bookings (관리자 X-Admin-Token)
 * 확정: POST /api/bookings/:id/confirm (관리자) → 집 서버 POST
 */

function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res, env) {
  const h = new Headers(res.headers);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => h.set(k, v));
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data, status, env) {
  return withCors(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }),
    env,
  );
}

async function readPendingIds(env) {
  const raw = await env.BOOKINGS.get('pending_ids');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writePendingIds(env, ids) {
  await env.BOOKINGS.put('pending_ids', JSON.stringify(ids));
}

async function appendPending(env, id) {
  const ids = await readPendingIds(env);
  if (!ids.includes(id)) ids.push(id);
  await writePendingIds(env, ids);
}

async function removePending(env, id) {
  const ids = (await readPendingIds(env)).filter((x) => x !== id);
  await writePendingIds(env, ids);
}

function requireAdmin(request, env) {
  const token = request.headers.get('X-Admin-Token') || '';
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return false;
  return true;
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON 파싱 실패' }, 400, env);
  }

  const customerName = (body.customerName || '').trim();
  const customerPhone = (body.customerPhone || '').trim();
  const reserveDate = (body.reserveDate || '').trim();
  const reserveTime = (body.reserveTime || '').trim();
  const partySize = body.partySize;
  const payMethod = (body.payMethod || '').trim() || '미정';
  const roomName = (body.roomName || '').trim() || null;

  if (!customerName || !customerPhone || !reserveDate || !reserveTime) {
    return json({ error: '이름, 연락처, 날짜, 시간은 필수입니다.' }, 400, env);
  }
  const pax = parseInt(String(partySize), 10);
  if (Number.isNaN(pax) || pax < 1 || pax > 4) {
    return json({ error: '인원은 1~4입니다.' }, 400, env);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const record = {
    id,
    status: 'pending',
    createdAt,
    customerName,
    customerPhone,
    reserveDate,
    reserveTime,
    partySize: pax,
    payMethod,
    roomName,
  };

  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(record));
  await appendPending(env, id);

  return json({ ok: true, bookingId: id, message: '신청이 접수되었습니다. 관리자 확정 후 예약이 완료됩니다.' }, 200, env);
}

async function handleList(request, env) {
  if (!requireAdmin(request, env)) {
    return json({ error: '관리자 토큰이 필요합니다.' }, 401, env);
  }
  const ids = await readPendingIds(env);
  const bookings = [];
  for (const id of ids) {
    const raw = await env.BOOKINGS.get(`booking:${id}`);
    if (!raw) continue;
    try {
      const b = JSON.parse(raw);
      if (b.status === 'pending') bookings.push(b);
    } catch {
      continue;
    }
  }
  bookings.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json({ ok: true, bookings }, 200, env);
}

async function handleConfirm(request, env, id) {
  if (!requireAdmin(request, env)) {
    return json({ error: '관리자 토큰이 필요합니다.' }, 401, env);
  }

  const raw = await env.BOOKINGS.get(`booking:${id}`);
  if (!raw) return json({ error: '예약을 찾을 수 없습니다.' }, 404, env);

  let booking;
  try {
    booking = JSON.parse(raw);
  } catch {
    return json({ error: '데이터 오류' }, 500, env);
  }

  if (booking.status !== 'pending') {
    return json({ error: '이미 처리된 예약입니다.', status: booking.status }, 400, env);
  }

  const homeUrl = (env.HOME_SERVER_URL || '').trim().replace(/\/$/, '');
  const ingestSecret = (env.BOOKING_INGEST_SECRET || '').trim();
  if (!homeUrl || !ingestSecret) {
    return json({ error: 'Worker에 HOME_SERVER_URL 또는 BOOKING_INGEST_SECRET이 설정되지 않았습니다.' }, 503, env);
  }

  const payload = {
    booking_id: booking.id,
    customer_name: booking.customerName,
    customer_phone: booking.customerPhone,
    reserve_date: booking.reserveDate,
    reserve_time: booking.reserveTime,
    party_size: booking.partySize,
    pay_method: booking.payMethod,
  };
  if (booking.roomName) payload.room_name = booking.roomName;

  let homeRes;
  try {
    homeRes = await fetch(`${homeUrl}/api/ingest/booking`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ingestSecret}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return json({ error: '집 서버 연결 실패', detail: String(e) }, 502, env);
  }

  const homeText = await homeRes.text();
  let homeJson;
  try {
    homeJson = JSON.parse(homeText);
  } catch {
    homeJson = { raw: homeText };
  }

  if (!homeRes.ok) {
    return json(
      {
        error: '집 서버가 예약을 거절했습니다.',
        status: homeRes.status,
        home: homeJson,
      },
      502,
      env,
    );
  }

  booking.status = 'confirmed';
  booking.confirmedAt = new Date().toISOString();
  booking.reservationId = homeJson.reservation_id ?? null;
  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking));
  await removePending(env, id);

  return json(
    {
      ok: true,
      message: '예약이 집 서버에 반영되었습니다.',
      reservationId: homeJson.reservation_id,
    },
    200,
    env,
  );
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), env);
    }

    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    try {
      if (path === '/api/bookings' && request.method === 'POST') {
        return handleCreate(request, env);
      }
      if (path === '/api/bookings' && request.method === 'GET') {
        return handleList(request, env);
      }
      const confirmPrefix = '/api/bookings/';
      const confirmSuffix = '/confirm';
      if (
        path.startsWith(confirmPrefix) &&
        path.endsWith(confirmSuffix) &&
        request.method === 'POST'
      ) {
        const id = path.slice(confirmPrefix.length, -confirmSuffix.length);
        if (!id) return json({ error: 'not found' }, 404, env);
        return handleConfirm(request, env, id);
      }

      if (path === '/api/health' && request.method === 'GET') {
        return json({ ok: true }, 200, env);
      }

      return json({ error: 'not found' }, 404, env);
    } catch (e) {
      return json({ error: '서버 오류', detail: String(e) }, 500, env);
    }
  },
};
