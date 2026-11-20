const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchWeather } = require('../pet-app/runtime/electron-helper/pet-weather.js');

const observation = {
  province: '北京市',
  city: '北京',
  adcode: '110000',
  weather: '多云',
  weather_icon: '101',
  temperature: -2.5,
  wind_direction: '西北风',
  wind_power: '6-7',
  humidity: 22,
  report_time: '2026-11-20 14:00:00',
};

test('sends only the manually chosen city to UApiPro and returns the current observation', async () => {
  let sentUrl;
  let sentOptions;
  const result = await fetchWeather('  北京  ', {
    request: async (url, options) => {
      sentUrl = new URL(url);
      sentOptions = options;
      return Response.json(observation);
    },
  });

  assert.equal(sentUrl.origin + sentUrl.pathname, 'https://uapis.cn/api/v1/misc/weather');
  assert.deepEqual(Object.fromEntries(sentUrl.searchParams), { city: '北京', lang: 'zh' });
  assert.equal(sentOptions.credentials, 'omit');
  assert.equal(sentOptions.redirect, 'error');
  assert.deepEqual(result, { ok: true, message: '北京 · 多云 · -2.5 ℃' });
});

test('rejects missing or invalid city names before requesting weather', async () => {
  let requestCount = 0;
  for (const city of [undefined, null, [], '', ' \t ', '天\u0000津', 'a'.repeat(81)]) {
    const result = await fetchWeather(city, {
      request: async () => {
        requestCount++;
        return Response.json(observation);
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /输入.*城市/);
  }
  assert.equal(requestCount, 0);
});

test('treats characters within the city name as data', async () => {
  let sentUrl;
  await fetchWeather('St. John\'s & adcode=110000', {
    request: async (url) => {
      sentUrl = new URL(url);
      return Response.json({ error: 'LOCATION_NOT_FOUND', details: '' }, { status: 404 });
    },
  });
  assert.deepEqual(Object.fromEntries(sentUrl.searchParams), {
    city: 'St. John\'s & adcode=110000', lang: 'zh',
  });
});

test('tells the user when the city is unknown or the service limits requests', async () => {
  for (const [status, body, message] of [
    [404, { error: 'LOCATION_NOT_FOUND', details: '' }, /未找到.*城市/],
    [404, { code: 'NOT_FOUND', message: '未找到该城市的天气数据' }, /未找到.*城市/],
    [429, { error: 'TOO_MANY_REQUESTS', details: '' }, /太频繁/],
    [429, { error: 'VISITOR_MONTHLY_QUOTA_EXHAUSTED' }, /本月.*额度/],
  ]) {
    const result = await fetchWeather('北京', {
      request: async () => Response.json(body, { status }),
    });
    assert.equal(result.ok, false);
    assert.match(result.message, message);
  }
});

test('handles network failures and rejects unusable observations without showing raw provider errors', async () => {
  for (const request of [
    async () => { throw new TypeError('connection failed at https://uapis.cn'); },
    async () => { throw new DOMException('Request timed out', 'TimeoutError'); },
    async () => Response.json({ code: 'SERVICE_UNAVAILABLE' }, { status: 503 }),
    async () => new Response('<!doctype html>'),
    async () => Response.json(null),
    async () => Response.json({ ...observation, temperature: null }),
    async () => Response.json({ ...observation, weather: '  ' }),
  ]) {
    const result = await fetchWeather('北京', { request });
    assert.equal(result.ok, false);
    assert.match(result.message, /稍后再试/);
  }
});
