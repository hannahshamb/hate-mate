require('dotenv/config');
const path = require('path');
const pg = require('pg');
const express = require('express');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const ClientError = require('./client-error');
const errorMiddleware = require('./error-middleware');
const authorizationMiddleware = require('./authorization-middleware');

const app = express();
const publicPath = path.join(__dirname, 'public');
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

if (process.env.NODE_ENV === 'development') {
  app.use(require('./dev-middleware')(publicPath));
} else {
  app.use(express.static(publicPath));
}

const jsonMiddleware = express.json();
app.use(jsonMiddleware);

app.get('/api/hello', (req, res) => {
  res.json({ hello: 'world' });
});

app.post('/api/auth/sign-in', (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ClientError(400, 'username and password are required fields');
  }
  const sql = `
  select "userId",
          "hashedPassword"
        from "users"
      where "email" = $1`;
  const params = [email];
  db.query(sql, params)
    .then(result => {
      const [user] = result.rows;
      if (!user) {
        throw new ClientError(401, 'invalid login');
      }
      const { userId, hashedPassword } = user;
      return argon2
        .verify(hashedPassword, password)
        .then(isMatching => {
          if (!isMatching) {
            throw new ClientError(401, 'invalid login');
          }
          const payload = { userId, email };
          const token = jwt.sign(payload, process.env.TOKEN_SECRET);
          res.json({ token, user: payload });
        });
    })
    .catch(err => next(err));
});

app.post('/api/auth/register', (req, res, next) => {
  const { firstName, email, password, confirmPassword } = req.body;
  if (!firstName || !email || !password) {
    throw new ClientError(400, 'username and password are required fields');
  }
  if (password !== confirmPassword) {
    throw new ClientError(400, 'passwords do not match');
  }
  argon2
    .hash(password)
    .then(hashedPassword => {
      const sql = `
      insert into "users" ("firstName", "email", "hashedPassword")
      values ($1, $2, $3)
      returning "userId", "email", "createdAt"
      `;
      const params = [firstName, email, hashedPassword];
      return db.query(sql, params);
    })
    .then(result => {
      const [user] = result.rows;
      res.status(201).json(user);
    })
    .catch(err => next(err));
});

app.use(authorizationMiddleware);

app.post('/api/auth/profile-info', (req, res, next) => {
  const { userId } = req.user;
  const { birthday, gender, phone, contact } = req.body;
  if (!birthday || !gender || !contact) {
    throw new ClientError(400, 'Birthday, gender, phone, and contact are required fields');
  }
  const sql = `
  insert into "userInfos" ("userId", "birthday", "gender", "phone", "contact")
  values($1, $2, $3, $4, $5)
  returning *
  `;
  const params = [userId, birthday, gender, phone, contact];
  db.query(sql, params)
    .then(result => {
      res.status(201).json(result.rows);
    })
    .catch(err => next(err));
});

app.post('/api/auth/friend-preferences', (req, res, next) => {
  const { userId } = req.user;
  const { city, zipCode, lat, lng, mileRadius, friendGender, friendAge } = req.body;
  if (!city || !zipCode || !lat || !lng || !mileRadius || !friendGender || !friendAge) {
    throw new ClientError(400, 'City, zip code, latitude, longitude, mile radius, friend gender preference, and friend age range preference are required fields');
  }
  const sql = `
  insert into "friendPreferences" ("userId", "city", "zipCode", "lat", "lng", "mileRadius", "friendGender", "friendAge")
  values($1, $2, $3, $4, $5, $6, $7, $8)
  returning *
  `;
  const params = [userId, city, zipCode, lat, lng, mileRadius, friendGender, friendAge];
  db.query(sql, params)
    .then(result => {
      res.status(201).json(result.rows);
    });

});

app.use(errorMiddleware);

app.listen(process.env.PORT, () => {
  process.stdout.write(`\n\napp listening on port ${process.env.PORT}\n\n`);
});
