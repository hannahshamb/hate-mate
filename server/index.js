require('dotenv/config');
const path = require('path');
const pg = require('pg');
const express = require('express');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const ClientError = require('./client-error');
const errorMiddleware = require('./error-middleware');
const authorizationMiddleware = require('./authorization-middleware');
const uploadsMiddleware = require('./uploads-middleware');
const sendUserEmail = require('./email');

const app = express();
const publicPath = path.join(__dirname, 'public');
const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const getAge = birthday => {
  const today = new Date();
  const birthDate = new Date(birthday);
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

const pointDistance = (centerLatDeg, centerLngDeg, checkLatDeg, checkLngDeg) => {
  const radiusEarth = 6378.1;
  const centerLat = centerLatDeg * Math.PI / 180;
  const centerLng = centerLngDeg * Math.PI / 180;
  const checkLat = checkLatDeg * Math.PI / 180;
  const checkLng = checkLngDeg * Math.PI / 180;

  const deltaLng = Math.abs(centerLng - checkLng);
  const distance = radiusEarth * Math.acos((Math.sin(centerLat) * Math.sin(checkLat)) + (Math.cos(centerLat) * Math.cos(checkLat) * Math.cos(deltaLng)));
  const distanceMiles = Math.round(((distance / 1.609344) * 10), 1) / 10;
  return distanceMiles;
};

if (process.env.NODE_ENV === 'development') {
  app.use(require('./dev-middleware')(publicPath));
} else {
  app.use(express.static(publicPath));
}

app.use(express.urlencoded({ extended: false }));
app.set('view engine', 'jsx');

const jsonMiddleware = express.json();
app.use(jsonMiddleware);

app.post('/api/auth/sign-in', (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new ClientError(400, 'Username and password are required fields');
  }
  const sql = `
  select "userId",
          "hashedPassword",
          "demoUser",
          "demoId"
        from "users"
      where "email" = $1`;
  const params = [email];
  db.query(sql, params)
    .then(result => {
      const [user] = result.rows;
      if (result.rows.length === 0) {
        throw new ClientError(404, 'Invalid login, no user with this email exists');
      }
      const { userId, hashedPassword, demoUser, demoId } = user;
      if (hashedPassword === process.env.DEMO_USER_PWD) {
        const payload = { userId, email, demoUser, demoId };
        const token = jwt.sign(payload, process.env.TOKEN_SECRET);
        res.json({ token, user: payload });
      } else {
        return argon2
          .verify(hashedPassword, password)
          .then(isMatching => {
            if (!isMatching) {
              throw new ClientError(400, 'Invalid login, email or password is incorrect');
            }
            const payload = { userId, email, demoUser, demoId };
            const token = jwt.sign(payload, process.env.TOKEN_SECRET);
            res.json({ token, user: payload });
          });
      }
    })
    .catch(err => next(err));
});

const { TOKEN_SECRET } = process.env;
app.post('/api/auth/forgot-password', (req, res, next) => {
  const { forgottenEmail } = req.body;
  const urlHost = req.get('host');
  if (!forgottenEmail) {
    throw new ClientError(400, 'Forgotten email is a required field');
  }
  const sql = `
   select "userId",
          "firstName",
          "email",
          "hashedPassword"
      from "users"
     where "email" = $1
  `;
  const params = [forgottenEmail];
  db.query(sql, params)
    .then(result => {
      const [user] = result.rows;
      if (!user) {
        throw new ClientError(202, 'User with this email does not exist');
      }
      const secret = TOKEN_SECRET + user.hashedPassword;
      const payload = {
        email: user.email,
        id: user.userId
      };
      const token = jwt.sign(payload, secret, { expiresIn: '15m' });
      const link = `http://${urlHost}/#reset-password/${user.userId}/${token}`;
      sendUserEmail.sendUserEmail(user.firstName, user.email, link, token);
      res.status(201).json(link);
    })
    .catch(err => next(err));
});

app.get('/api/auth/reset-password/:id/:token', (req, res, next) => {
  const { id, token } = req.params;

  const sql = `
   select "userId",
          "firstName",
          "email",
          "hashedPassword"
      from "users"
     where "userId" = $1
  `;

  const params = [id];
  db.query(sql, params)
    .then(result => {
      const [user] = result.rows;
      if (!user || user.userId !== id) {
        res.status(202, 'Not a valid user');
      }
      const secret = TOKEN_SECRET + user.hashedPassword;

      try {
        jwt.verify(token, secret);
        res.status(201).json(user);
      } catch (error) {
        res.status(202).json(error.message);
      }
    });
});

app.post('/api/auth/reset-password', (req, res, next) => {
  const { userId, password, confirmPassword } = req.body;
  if (!password || !confirmPassword) {
    throw new ClientError(400, 'Password is a required field');
  }
  if (password !== confirmPassword) {
    throw new ClientError(400, 'passwords do not match');
  }
  argon2
    .hash(password)
    .then(hashedPassword => {
      const sql = `
      update "users"
      set "hashedPassword" = $2
    where "userId" = $1
    returning *
        `;
      const params = [userId, hashedPassword];
      return db.query(sql, params);
    })
    .then(result => {
      const [user] = result.rows;
      res.status(201).json(user);
    })
    .catch(err => {
      next(err);
    });
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

      on conflict on constraint "users_email_key"
        do nothing
      returning "userId", "email", "createdAt"
        `;
      const params = [firstName, email, hashedPassword];
      return db.query(sql, params);
    })
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('email already exists');
      }
      const [user] = result.rows;
      res.status(201).json(user);
    })
    .catch(err => {
      next(err);
    }
    );
});

app.get('/api/selections/:categoryId', (req, res, next) => {
  const categoryId = Number(req.params.categoryId);
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    throw new ClientError(400, 'CategoryId must be a positive integer');
  }
  const sql = `
  select *
     from "selections"
   where "categoryId" = $1
  `;

  const params = [categoryId];
  db.query(sql, params)
    .then(result => {
      const selections = result.rows;
      if (!selections) {
        throw new ClientError(404, `Cannot find selections with categoryId ${categoryId}`);
      } else {
        res.json(selections);
      }
    })
    .catch(err => {
      next(err);
    });
});

app.get('/api/categories', (req, res, next) => {
  const sql = `
  select * from "categories"
  `;
  db.query(sql)
    .then(result => {
      const categories = result.rows;
      res.json(categories);
    })
    .catch(err => {
      next(err);
    });
});

app.get('/api/categories/:categoryId', (req, res, next) => {
  const categoryId = Number(req.params.categoryId);
  if (!Number.isInteger(categoryId) || categoryId < 1) {
    throw new ClientError(400, 'CategoryId must be a positive integer');
  }
  const sql = `
  select *
     from "categories"
   where "categoryId" = $1
  `;

  const params = [categoryId];
  db.query(sql, params)
    .then(result => {
      const categories = result.rows;
      if (!categories) {
        throw new ClientError(404, `Cannot find categories with categoryId ${categoryId}`);
      } else {
        res.json(categories);
      }
    })
    .catch(err => {
      next(err);
    });
});

app.get('/api/selections/selection/:selectionId', (req, res, next) => {
  const selectionId = Number(req.params.selectionId);
  if (!Number.isInteger(selectionId) || selectionId < 1) {
    throw new ClientError(400, 'SelectionId must be a positive integer');
  }
  const sql = `
  select *
     from "selections"
   where "selectionId" = $1
  `;

  const params = [selectionId];
  db.query(sql, params)
    .then(result => {
      const selections = result.rows;
      if (!selections) {
        throw new ClientError(404, `Cannot find selections with selectionId ${selectionId}`);
      } else {
        res.json(selections);
      }
    })
    .catch(err => {
      next(err);
    });
});

app.post('/api/match-status-update', (req, res, next) => {
  const { userId1, userId2, statusToUpdate, status } = req.body;
  if (!userId1 || !userId2 || !statusToUpdate || !status) {
    throw new ClientError(400, 'user1Id, user2Id, status to update, and status are required fields');
  }
  if (!Number.isInteger(Number(userId1)) || Number(userId1) < 1) {
    throw new ClientError(400, 'userId1 must be a positive integer');
  }
  if (!Number.isInteger(Number(userId2)) || Number(userId2) < 1) {
    throw new ClientError(400, 'userId2 must be a positive integer');
  }

  let sql;
  if (statusToUpdate === 'user1Status') {
    sql = `
    update "matches"
      set "user1Status" = $3
    where "userId1" = $1
      and "userId2" = $2
    returning *
    `;
  } else {
    sql = `
    update "matches"
      set "user2Status" = $3
     where "userId1" = $1
      and "userId2" = $2
    returning *
    `;
  }
  const params = [userId1, userId2, status];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length > 0) {
        const statuses = {
          userId1: result.rows[0].userId1,
          userId2: result.rows[0].userId2,
          user1Status: result.rows[0].user1Status,
          user2Status: result.rows[0].user2Status
        };
        const { user1Status, user2Status } = statuses;
        let matchStatus = '';
        if (user1Status === 'accepted' && user2Status === 'accepted') {
          matchStatus = 'accepted';
        } else if (user1Status === 'rejected' || user2Status === 'rejected') {
          matchStatus = 'rejected';
        } else {
          matchStatus = 'pending';
        }

        const sql = `
        update "matches"
          set "matchStatus" = $3
         where "userId1" = $1
            and "userId2" = $2
        returning *
        `;
        const params = [userId1, userId2, matchStatus];
        db.query(sql, params)
          .then(nextRes => {
            res.status(201).json(nextRes.rows);
          }).catch(err => next(err));
      }
    })
    .catch(err => next(err));
});

app.post('/api/demo-ids', (req, res, next) => {
  const demoData = req.body;

  if (!demoData) {
    throw new ClientError(400, 'demoUserData required');
  }

  /* first we search for the userIds and add them to the demoData array
 "users" where demoId = values
 */
  let where = 'where ';
  let demoUser;
  const params2 = [];

  demoData.forEach(demoDummy => {
    if (demoDummy.demoId) {
      params2.push(demoDummy.demoId);
    } else {
      demoUser = demoDummy;
    }

  });

  params2.forEach((param, index) => {
    if (index !== params2.length - 1) {
      where += `"demoId" = $${index + 1} OR `;
    } else {
      where += `"demoId" = $${index + 1}`;
    }
  });

  const sql2 = `
  select * from "users"
    ${where}
  `;

  const sql = `
  insert into "users" ("firstName", "email", "hashedPassword", "demoUser")
  values ($1, $2, $3, $4)
  RETURNING *
  `;

  const params = [demoUser.firstName, demoUser.email, demoUser.hashedPassword, demoUser.demoUser];

  db.query(sql, params)
    .then(result => {
      const demoUser = result.rows;
      db.query(sql2, params2)
        .then(result => {
          const userData = result.rows;
          userData.push(demoUser[0]);
          res.status(201).json(userData);
        });
    })
    .catch(err => next(err));
});

app.post('/api/setup-demo', (req, res, next) => {
  const demoData = req.body;
  if (!demoData) {
    throw new ClientError(400, 'demoUserData required');
  }

  const sql = `
WITH updated_userInfos AS (
  INSERT INTO "userInfos" ("userId", "birthday", "gender", "phone", "contact")
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT ON CONSTRAINT "userInfos_pk"
  DO UPDATE
    SET "birthday" = excluded."birthday",
        "gender" = excluded."gender",
        "phone" = excluded."phone",
        "contact" = excluded."contact"
  RETURNING *
),
updated_friendPreferences AS (
INSERT INTO "friendPreferences" ("userId", "city", "zipCode", "lat", "lng", "mileRadius", "friendGender", "friendAge")
VALUES ($1, $6, $7, $8, $9, $10, $11, $12)
ON CONFLICT ON CONSTRAINT "friendPreferences_pk"
DO UPDATE
  SET "city" = excluded."city",
      "zipCode" = excluded."zipCode",
      "lat" = excluded."lat",
      "lng" = excluded."lng",
      "mileRadius" = excluded."mileRadius",
      "friendGender" = excluded."friendGender",
      "friendAge" = excluded."friendAge"
  RETURNING *
  )
  INSERT INTO "profilePics" ("userId", "url", "fileName")
  VALUES ($1, $13, $14)
  ON CONFLICT ON CONSTRAINT "profilePics_pk"
  DO UPDATE
    SET "url" = excluded."url",
        "fileName" = excluded."fileName"
  RETURNING *

  ;
`;

  const params = [demoData.userId,
    demoData.userInfos.birthday, demoData.userInfos.gender, demoData.userInfos.phone, demoData.userInfos.contact,
    demoData.friendPreferences.city, demoData.friendPreferences.zipCode, demoData.friendPreferences.lat, demoData.friendPreferences.lng, demoData.friendPreferences.mileRadius, demoData.friendPreferences.friendGender, demoData.friendPreferences.friendAge,
    demoData.profilePics.url, demoData.profilePics.fileName
  ];
  db.query(sql, params)
    .then(result => {
      let values = 'values ';
      const params2 = [];
      demoData.userSelections.forEach((selection, index) => {
        const { categoryId, selectionId } = selection;
        if (!selectionId || !categoryId) {
          throw new ClientError(400, 'SelectionIds and categoryIds are required fields');
        }
        if (!Number.isInteger(categoryId) || categoryId < 1) {
          throw new ClientError(400, 'CategoryId must be a positive integer');
        }
        if (!Number.isInteger(selectionId) || selectionId < 1) {
          throw new ClientError(400, 'SelectionId must be a positive integer');
        }

        params2.push(Number(demoData.userId), Number(categoryId), Number(selectionId));
      });

      params2.forEach((param, i) => {
        if (i === params2.length - 1) {
          values += `($${i - 1}, $${i}, $${i + 1})`;
        } else if (i !== 0 && i % 3 === 0) {
          values += `($${i - 2}, $${i - 1}, $${i}), `;
        }
      });

      const sql2 = `
         insert into "userSelections" ("userId", "categoryId", "selectionId")
          ${values}
          on conflict on constraint "userSelections_pk"
            do
            update set
              "selectionId" = EXCLUDED."selectionId"
          returning *
      `;
      db.query(sql2, params2)
        .then(result => {
          res.status(201).json(result.rows);
        })
        .catch(err => next(err));
    })
    .catch(err => next(err));

});

app.use(authorizationMiddleware);

app.post('/api/auth/profile-info', (req, res, next) => {
  const { userId } = req.user;
  const { birthday, gender, phone, contact } = req.body;
  if (!birthday || !gender || !contact) {
    throw new ClientError(400, 'Birthday, gender, and contact are required fields');
  }
  const sql = `
    insert into "userInfos" ("userId", "birthday", "gender", "phone", "contact")
    values($1, $2, $3, $4, $5)
    on conflict on constraint "userInfos_pk"
      do
      update set "birthday" = $2, "gender" = $3, "phone" = $4, "contact" = $5
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
  on conflict on constraint "friendPreferences_pk"
    do
    update set "city" = $2, "zipCode" = $3, "lat" = $4, "lng" = $5, "mileRadius" = $6, "friendGender" = $7, "friendAge" = $8
  returning *
  `;
  const params = [userId, city, zipCode, lat, lng, mileRadius, friendGender, friendAge];
  db.query(sql, params)
    .then(result => {
      res.status(201).json(result.rows);
    })
    .catch(err => next(err));
});

app.get('/api/auth/profile-friend-preference-info', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
  select
    "userInfos".*,
    "friendPreferences".*
  from "userInfos"
    join "friendPreferences" using ("userId")
  where "userId" = $1
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no info exists');
      } else {
        const { gender } = result.rows[0];
        const { friendGender } = result.rows[0];
        if (gender === null || friendGender === null) {
          res.status(202).json('no info exists');
        } else {
          res.status(200).json(result.rows);
        }
      }
    })
    .catch(err => next(err));
});

app.post('/api/auth/user-selections', (req, res, next) => {
  const { userId } = req.user;
  const { selections } = req.body;

  if (!selections) {
    throw new ClientError(400, 'Selections are required');
  }

  const params = [];
  let values = 'values ';

  selections.forEach((selection, index) => {
    const { categoryId, selectionId } = selection;
    if (!selectionId || !categoryId) {
      throw new ClientError(400, 'SelectionIds and categoryIds are required fields');
    }
    if (!Number.isInteger(categoryId) || categoryId < 1) {
      throw new ClientError(400, 'CategoryId must be a positive integer');
    }
    if (!Number.isInteger(selectionId) || selectionId < 1) {
      throw new ClientError(400, 'SelectionId must be a positive integer');
    }

    params.push(Number(userId), Number(categoryId), Number(selectionId));
  });

  params.forEach((param, i) => {
    if (i === params.length - 1) {
      values += `($${i - 1}, $${i}, $${i + 1})`;
    } else if (i !== 0 && i % 3 === 0) {
      values += `($${i - 2}, $${i - 1}, $${i}), `;
    }
  });

  const sql = `
  insert into "userSelections" ("userId", "categoryId", "selectionId")
  ${values}
  on conflict on constraint "userSelections_pk"
    do
    update set
      "selectionId" = EXCLUDED."selectionId"
  returning *
  `;

  db.query(sql, params)
    .then(result => {
      res.status(201).json(result.rows);
    })
    .catch(err => next(err));
});

app.get('/api/auth/user-selections', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
  select * from "userSelections"
  where "userId" = $1
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no info exists');
      } else res.status(200).json(result.rows);
    })
    .catch(err => next(err));
});

app.get('/api/auth/profile-picture', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
  select * from "profilePics"
  where "userId" = $1
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no info exists');
      } else res.status(200).json(result.rows[0]);
    })
    .catch(err => next(err));
});

app.get('/api/auth/user-info/:userId', (req, res, next) => {
  const userId = Number(req.params.userId);
  const sql = `
  select "users"."firstName",
         "userSelections"."selectionId",
         "selections"."selectionName",
         "profilePics".*
  from "users"
  join "userSelections" using ("userId")
  join "selections" using ("selectionId")
  left join "profilePics" using ("userId")
  where "userId" = $1
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no user info exists');
      } else res.status(200).json(result.rows);
    })
    .catch(err => next(err));
});

app.get('/api/auth/find-matches/', (req, res, next) => {
  const { userId } = req.user;
  if (!userId) {
    throw new ClientError(400, 'userId is required');
  }

  const sql = `
  select "users"."demoUser",
        "users"."demoId",
        "friendPreferences".*,
         "userInfos".*,
         "userSelections".*
  from "users"
  join "friendPreferences" using ("userId")
  join "userInfos" using ("userId")
  join "userSelections" using ("userId")
  where "userId" = $1
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no user exists');
      } else {
        const currentUserInfo = result.rows[0];
        const currentUserSelects = result.rows.map(selection => {
          return {
            userId: selection.userId,
            categoryId: selection.categoryId,
            selectionId: selection.selectionId
          };
        });
        const { friendGender } = currentUserInfo;
        const friendGenderArray = friendGender.replace(/{|}|"|"/g, '').split(',');
        const bodyGenderArray = [];
        friendGenderArray.forEach((friendGender, i) => {
          if (friendGender === 'nonBinary') {
            friendGender = 'non-binary';
          }
          bodyGenderArray.push({ friendGender });
        });
        let where;

        // if the current user is a demo user, filter out the real users and select only the demo dummys
        // else if NOT a demo user, pull all only the demoUser === false users (excludes dummys)
        if (currentUserInfo.demoUser) {
          if (bodyGenderArray.length === 1) {
            where = 'where ("userInfos"."gender" = $1 OR "userInfos"."gender" = $2 OR "userInfos"."gender" = $3) AND "users"."demoId" IS NOT NULL';
          } else if (bodyGenderArray.length === 2) {
            where = 'where ("userInfos"."gender" = $1 OR "userInfos"."gender" = $2) AND "users"."demoId" IS NOT NULL';
          } else if (bodyGenderArray.length === 3) {
            where = 'where ("userInfos"."gender" = $1 OR "userInfos"."gender" = $2 OR "userInfos"."gender" = $3) AND "users"."demoId" IS NOT NULL';
          }
        } else if (currentUserInfo.demoUser === false) {
          if (bodyGenderArray.length === 1) {
            where = 'where "userInfos"."gender" = $1 AND "users"."demoUser" = $2 AND "users"."demoId" IS NULL';
          } else if (bodyGenderArray.length === 2) {
            where = 'where ("userInfos"."gender" = $1 OR "userInfos"."gender" = $2 OR  "userInfos"."gender" = $3) AND "users"."demoUser" = $3 AND "users"."demoId" IS NULL';
          } else if (bodyGenderArray.length === 3) {
            where = 'where ("userInfos"."gender" = $1 OR "userInfos"."gender" = $2 OR  "userInfos"."gender" = $3) AND "users"."demoUser" = $4 AND "users"."demoId" IS NULL';
          }
        }

        const sql = `
        select  "users"."firstName",
                "users"."demoUser",
                "userInfos".*,
                "users"."demoId",
                "friendPreferences".*,
                "profilePics"."url",
                "profilePics"."fileName"
          from "users"
          join "userInfos" using ("userId")
          join "friendPreferences" using ("userId")
          left join "profilePics" using ("userId")
          ${where}
        `;
        const params = bodyGenderArray.map(gender => {
          return gender.friendGender;
        });
        if (!currentUserInfo.demoUser) {
          params.push(false);
        }

        db.query(sql, params)
          .then(result => {
            if (result.rows.length === 0) {
              res.status(202).json('no potential matches exist');
            } else {
              const potentialGenderMatches = result.rows;
              const potentialMatches = [];

              const isAgeMatch = (age, friendAge) => {
                if (friendAge === '52+') {
                  const youngestFriend = 52;
                  if (age >= youngestFriend) {
                    return true;
                  } else return false;
                } else {
                  const friendAgeArray = friendAge.split('-');
                  const youngestFriend = parseInt(friendAgeArray[0]);
                  const oldestFriend = parseInt(friendAgeArray[1]);
                  if (age >= youngestFriend && age <= oldestFriend) {
                    return true;
                  } else {
                    return false;
                  }
                }

              };
              const isGenderMatch = (gender, friendGender) => {
                let genderMatch = false;
                const checkGenderArray = friendGender.replace(/{|}|"|"/g, '').split(',');
                checkGenderArray.forEach(genderCheck => {
                  let genderCompare;
                  if (genderCheck === 'nonBinary') {
                    genderCompare = 'non-binary';
                  } else {
                    genderCompare = genderCheck;
                  }
                  if (gender === genderCompare) {
                    genderMatch = true;
                  }
                });
                return genderMatch;
              };

              potentialGenderMatches.forEach(potentialMatch => {
                if (potentialMatch.userId !== currentUserInfo.userId) {
                  const kmCenterRadius = currentUserInfo.mileRadius * 1.60934;
                  const kmCheckRadius = potentialMatch.mileRadius * 1.609344;
                  const centerLat = currentUserInfo.lat;
                  const centerLng = currentUserInfo.lng;
                  const checkLat = potentialMatch.lat;
                  const checkLng = potentialMatch.lng;

                  const distance = pointDistance(centerLat, centerLng, checkLat, checkLng);
                  const potentialMatchNear = distance <= kmCenterRadius;
                  const userNearPotentialMatch = distance <= kmCheckRadius;

                  const locationMatch = !!(potentialMatchNear && userNearPotentialMatch);
                  if (isAgeMatch(getAge(potentialMatch.birthday), currentUserInfo.friendAge) &&
                    isAgeMatch(getAge(currentUserInfo.birthday), potentialMatch.friendAge) &&
                    isGenderMatch(potentialMatch.gender, currentUserInfo.friendGender) &&
                    isGenderMatch(currentUserInfo.gender, potentialMatch.friendGender) && locationMatch) {
                    potentialMatch.age = getAge(potentialMatch.birthday);
                    potentialMatch.mileage = distance;
                    potentialMatches.push(potentialMatch);
                  }
                }

              });
              if (potentialMatches.length === 0) {
                res.status(202).json('no potential matches exist');
              } else {
                const params = potentialMatches.map(potentialMatch => {
                  return potentialMatch.userId;
                });

                let where = 'where ';
                params.forEach((param, index) => {
                  if (index === params.length - 1) {
                    where += `"userId"=$${index + 1}`;
                  } else where += `"userId"=$${index + 1} OR `;
                });

                const sql = ` select "userSelections".*,
                              "users"."demoId"
                              from "userSelections"
                              join "users" using ("userId")
                              ${where}`;

                db.query(sql, params)
                  .then(result => {
                    if (result.rows.length === 0) {
                      res.status(202).json('no potential matches exist');
                    } else {
                      const potentialMatchSelects = result.rows;
                      const matchSelections = [];
                      potentialMatchSelects.forEach(potentialMatchSelect => {
                        currentUserSelects.forEach(currentUserSelect => {
                          if (potentialMatchSelect.categoryId === currentUserSelect.categoryId) {
                            if (potentialMatchSelect.selectionId === currentUserSelect.selectionId) {
                              let userId1;
                              let userId2;
                              let demoId1;
                              let demoId2;

                              if (currentUserSelect.userId < potentialMatchSelect.userId) {
                                userId1 = currentUserSelect.userId;
                                demoId1 = currentUserInfo.demoId;
                                userId2 = potentialMatchSelect.userId;
                                demoId2 = potentialMatchSelect.demoId;
                              } else {
                                userId1 = potentialMatchSelect.userId;
                                demoId1 = potentialMatchSelect.demoId;
                                userId2 = currentUserSelect.userId;
                                demoId2 = currentUserInfo.demoId;
                              }
                              const match = {
                                userId1,
                                demoId1,
                                userId2,
                                demoId2,
                                categoryId: currentUserSelect.categoryId,
                                selectionId: currentUserSelect.selectionId
                              };
                              matchSelections.push(match);
                            }
                          }
                        });
                      });
                      const potentialMatchData = {
                        potentialMatches,
                        matchSelections
                      };
                      res.status(200).json(potentialMatchData);
                    }
                  });
              }
            }
          });
      }
    })
    .catch(err => next(err));
});

app.post('/api/auth/post-matches/', (req, res, next) => {
  const { allMatchTypes, matchSelections, user } = req.body;
  if (!matchSelections || !allMatchTypes || !user) {
    throw new ClientError(400, 'matchSelections, allMatchTypes and user are required');
  }

  const sql = `
  delete from "matchSelections"
  where "userId1" = $1 OR "userId2" = $1
  returning *
  `;
  const params = [user.userId];
  db.query(sql, params)
    .then(result => {
      const params = [];
      let values = 'values ';
      if (matchSelections.length !== 0) {
        matchSelections.forEach((matchSelection, i) => {
          params.push(matchSelection.userId1);
          params.push(matchSelection.userId2);
          params.push(matchSelection.categoryId);
          params.push(matchSelection.selectionId);
        });
        params.forEach((param, i) => {
          if (i === params.length - 1) {
            values += `($${i - 2}, $${i - 1}, $${i}, $${i + 1})`;
          } else if (i !== 0 && i % 4 === 0) {
            values += `($${i - 3}, $${i - 2}, $${i - 1}, $${i}), `;
          }
        });
        const sql = `
        insert into "matchSelections" ("userId1", "userId2", "categoryId", "selectionId")
        ${values}
        on conflict on constraint "matchSelections_pk"
          do
          update set
            "selectionId" = EXCLUDED."selectionId"
        returning *
        `;
        db.query(sql, params)
          .then(result => {
            const sql = `
          select * from "matchSelections"
          join "selections" using ("selectionId")
          `;
            db.query(sql)
              .then(result => {
                const selections = result.rows;
                const sql = `
              select * from "matches"
              where "userId1" = $1 OR "userId2" = $1
              `;
                const params = [user.userId];

                db.query(sql, params)
                  .then(result => {
                    const existingMatches = result.rows;
                    const postMatches = [];
                    const matchesToUpdate = [];
                    const matchesToUpload = [];
                    const matchesToReject = [];

                    for (let i = 0; i < allMatchTypes.length; i++) {
                      let found = false;
                      for (let j = 0; j < existingMatches.length; j++) {
                        if (allMatchTypes[i].userId1 === existingMatches[j].userId1 && allMatchTypes[i].userId2 === existingMatches[j].userId2) {
                          found = true;
                          existingMatches[j].matchType = allMatchTypes[i].matchType;
                          matchesToUpdate.push(existingMatches[j]);
                          break;
                        }
                      }
                      if (!found) {
                        matchesToUpload.push(allMatchTypes[i]);
                      }
                    }

                    for (let i = 0; i < existingMatches.length; i++) {
                      let found = false;
                      for (let j = 0; j < allMatchTypes.length; j++) {
                        if (existingMatches[i].userId1 === allMatchTypes[j].userId1 && existingMatches[i].userId2 === allMatchTypes[j].userId2) {
                          found = true;
                          break;
                        }
                      }
                      if (!found) {
                        matchesToReject.push(existingMatches[i]);
                      }
                    }

                    if (matchesToUpdate.length > 0) {
                      matchesToUpdate.forEach(match => {
                        postMatches.push(match);
                      });
                    }

                    if (matchesToUpload.length > 0) {
                      matchesToUpload.forEach(match => {
                        if (user.demoUser) {
                          if ((match.demoId1 !== null && match.demoId1 <= 10) || (match.demoId2 !== null && match.demoId2 <= 10)) {
                            match.user1Status = 'accepted';
                            match.user2Status = 'accepted';
                            match.matchStatus = 'accepted';
                          } else if ((match.demoId1 !== null && match.demoId1 > 10) || (match.demoId2 !== null && match.demoId2 > 10)) {
                            if (user.userId === match.userId1) {
                              match.user1Status = 'pending';
                              match.user2Status = 'accepted';
                              match.matchStatus = 'pending';
                            } else {
                              match.user1Status = 'accepted';
                              match.user2Status = 'pending';
                              match.matchStatus = 'pending';
                            }
                          }
                        } else {
                          match.user1Status = 'pending';
                          match.user2Status = 'pending';
                          match.matchStatus = 'pending';
                        }
                        postMatches.push(match);
                      });
                    }
                    if (matchesToReject.length > 0) {
                      matchesToReject.forEach(match => {
                        if (match.matchStatus === 'rejected' || match.user1Status === 'rejected' || match.user2Status === 'rejected') {
                          match.matchStatus = 'rejected';
                        } else if (match.matchStatus === 'accepted' || (match.user1Status === 'accepted' && match.user2Status === 'accepted')) {
                          match.matchStatus = 'accepted';
                        } else {
                          match.matchStatus = 'pending';
                        }
                        match.matchType = 'no longer a match';
                        postMatches.push(match);
                      });
                    }

                    const params = [];
                    let values = 'values ';
                    postMatches.forEach((match, i) => {
                      params.push(match.userId1);
                      params.push(match.userId2);
                      params.push(match.matchType);
                      params.push(match.user1Status);
                      params.push(match.user2Status);
                      params.push(match.matchStatus);
                    });
                    params.forEach((param, i) => {
                      if (i === params.length - 1) {
                        values += `($${i - 4}, $${i - 3}, $${i - 2}, $${i - 1},  $${i} , $${i + 1})`;
                      } else if (i !== 0 && i % 6 === 0) {
                        values += `($${i - 5}, $${i - 4}, $${i - 3}, $${i - 2}, $${i - 1}, $${i}), `;
                      }
                    });
                    const sql = `
                  insert into "matches" ("userId1", "userId2", "matchType", "user1Status", "user2Status", "matchStatus")
                  ${values}
                  on conflict on constraint "matches_pk"
                    do
                    update set
                    "matchType"= EXCLUDED."matchType",
                    "matchStatus" = EXCLUDED."matchStatus"
                  returning *
                  `;
                    db.query(sql, params)
                      .then(result => {
                        const matches = result.rows;
                        matches.forEach(match => {
                          const matchSelections = [];
                          selections.forEach(selection => {
                            if (match.userId1 === selection.userId1 && match.userId2 === selection.userId2) {
                              matchSelections.push(selection);
                            }
                          });
                          match.matchSelections = matchSelections;
                        });
                        res.status(201).json(matches);
                      });
                  });

              });
          });
      } else {
        const sql = `
          select * from "matchSelections"
          join "selections" using ("selectionId")
          `;
        db.query(sql)
          .then(result => {
            const selections = result.rows;
            const sql = `
              select * from "matches"
              where "userId1" = $1 OR "userId2" = $1
              `;
            const params = [user.userId];

            db.query(sql, params)
              .then(result => {
                const existingMatches = result.rows;
                const matchesToUpdate = [];
                const matchesToUpload = [];
                const matchesToReject = [];

                for (let i = 0; i < allMatchTypes.length; i++) {
                  let found = false;
                  for (let j = 0; j < existingMatches.length; j++) {
                    if (allMatchTypes[i].userId1 === existingMatches[j].userId1 && allMatchTypes[i].userId2 === existingMatches[j].userId2) {
                      found = true;
                      existingMatches[j].matchType = allMatchTypes[i].matchType;
                      matchesToUpdate.push(existingMatches[j]);
                      break;
                    }
                  }
                  if (!found) {
                    matchesToUpload.push(allMatchTypes[i]);
                  }
                }

                for (let i = 0; i < existingMatches.length; i++) {
                  let found = false;
                  for (let j = 0; j < allMatchTypes.length; j++) {
                    if (existingMatches[i].userId1 === allMatchTypes[j].userId1 && existingMatches[i].userId2 === allMatchTypes[j].userId2) {
                      found = true;
                      break;
                    }
                  }
                  if (!found) {
                    matchesToReject.push(existingMatches[i]);
                  }
                }

                const postMatches = [];

                if (matchesToUpdate.length > 0) {
                  matchesToUpdate.forEach(match => {
                    postMatches.push(match);
                  });
                }

                if (matchesToUpload.length > 0) {
                  matchesToUpload.forEach(match => {
                    match.user1Status = 'pending';
                    match.user2Status = 'pending';
                    match.matchStatus = 'pending';
                    postMatches.push(match);
                  });
                }
                if (matchesToReject.length > 0) {
                  matchesToReject.forEach(match => {
                    if (match.matchStatus === 'rejected' || match.user1Status === 'rejected' || match.user2Status === 'rejected') {
                      match.matchStatus = 'rejected';
                    } else {
                      match.matchStatus = 'pending';
                    }
                    match.matchType = 'no longer a match';
                    postMatches.push(match);
                  });
                }
                const params = [];
                let values = 'values ';
                postMatches.forEach((match, i) => {
                  params.push(match.userId1);
                  params.push(match.userId2);
                  params.push(match.matchType);
                  params.push(match.user1Status);
                  params.push(match.user2Status);
                  params.push(match.matchStatus);
                });
                params.forEach((param, i) => {
                  if (i === params.length - 1) {
                    values += `($${i - 4}, $${i - 3}, $${i - 2}, $${i - 1},  $${i} , $${i + 1})`;
                  } else if (i !== 0 && i % 6 === 0) {
                    values += `($${i - 5}, $${i - 4}, $${i - 3}, $${i - 2}, $${i - 1}, $${i}), `;
                  }
                });

                const sql = `
                  insert into "matches" ("userId1", "userId2", "matchType", "user1Status", "user2Status", "matchStatus")
                  ${values}
                  on conflict on constraint "matches_pk"
                    do
                    update set
                    "matchType"= EXCLUDED."matchType",
                    "matchStatus" = EXCLUDED."matchStatus"
                  returning *
                  `;
                db.query(sql, params)
                  .then(result => {
                    const matches = result.rows;
                    matches.forEach(match => {
                      const matchSelections = [];
                      selections.forEach(selection => {
                        if (match.userId1 === selection.userId1 && match.userId2 === selection.userId2) {
                          matchSelections.push(selection);
                        }
                      });
                      match.matchSelections = matchSelections;
                    });
                    res.status(201).json(matches);
                  });
              });

          });
      }

    });

});

app.get('/api/auth/get-matches', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
 select * from matches
  where ("userId1" = $1 OR "userId2" = $1)
  AND ("matchStatus" = 'accepted') OR ("matchType" = 'no longer a match' AND "matchStatus" = 'accepted')
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      const matches = result.rows;
      if (matches.length > 0) {
        const matchIds = [];
        matches.forEach(match => {
          if (userId === match.userId1) {
            matchIds.push(match.userId2);
          } else {
            matchIds.push(match.userId1);
          }

        });

        let where = 'where ';
        matchIds.forEach((id, index) => {
          if (index === matchIds.length - 1) {
            where += `"userId"=$${(index + 1)}`;
          } else {
            where += `"userId"=$${(index + 1)} OR `;
          }
        });

        const params = matchIds.map(id => { return id; });
        const sql = `
        select
          "users"."userId" as "id",
          "users"."firstName",
          "userInfos"."birthday",
          "userInfos"."gender",
          "friendPreferences"."lat",
          "friendPreferences"."lng",
          "profilePics".*
        from "users"
            join "userInfos" using ("userId")
            join "friendPreferences" using ("userId")
            left join "profilePics" using ("userId")
            ${where}
        `;
        db.query(sql, params)
          .then(result => {
            const matchInfos = result.rows;

            const sql = `
            select "userId", "lat", "lng"
              from "friendPreferences"
            where "userId" = $1
            `;
            const params = [userId];

            db.query(sql, params)
              .then(result => {
                const centerLatDeg = result.rows[0].lat;
                const centerLngDeg = result.rows[0].lng;

                matchInfos.forEach(matchInfo => {
                  matchInfo.age = getAge(matchInfo.birthday);
                  matchInfo.mileage = pointDistance(centerLatDeg, centerLngDeg, matchInfo.lat, matchInfo.lng);
                  matches.forEach(match => {
                    if (match.userId1 === matchInfo.id || match.userId2 === matchInfo.id) {
                      matchInfo.matchType = match.matchType;
                    }
                  });
                });
                res.status(201).json(matchInfos);
              });

          });

      } else res.status(200).json('no matches yet');
    });

});

app.get('/api/auth/user-profile', (req, res, next) => {
  const { userId } = req.user;

  const sql = `
  select
    "users"."firstName",
    "users"."email",
    "userInfos".*,
    "friendPreferences".*,
    "profilePics".*
  from "users"
    join "userInfos" using ("userId")
    join "friendPreferences" using ("userId")
    left join "profilePics" using ("userId")
    where "userId" = $1
  `;

  const params = [userId];

  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no info exists');
      } else {
        const userInfo = result.rows;

        const sql = `
        select
          "userSelections"."selectionId",
          "selections".*
        from "userSelections"
          join "selections" using ("selectionId")
        where "userId" = $1
        `;

        db.query(sql, params)
          .then(result => {
            let selections;
            if (result.rows.length === 0) {
              selections = 'no info exists';
            } else {
              selections = result.rows;
            }
            res.status(201).json({ userInfo, selections });
          });

      }
    })
    .catch(err => next(err));
});

app.get('/api/auth/hate-mate-profile-info/:hateMateUserId', (req, res, next) => {
  const { userId } = req.user;
  const hateMateUserId = Number(req.params.hateMateUserId);
  if (!Number.isInteger(hateMateUserId) || hateMateUserId < 1) {
    throw new ClientError(400, 'hateMateUserId must be a positive integer');
  }

  if (hateMateUserId === userId) {
    throw new ClientError(400, 'userId and hateMateUserId cannot be the same');
  }

  const sql = `
  select
    "users"."firstName",
    "users"."email",
    "userInfos"."userId" as "id",
    "userInfos".*,
    "friendPreferences"."city",
    "friendPreferences"."zipCode",
    "profilePics".*
  from "users"
    join "userInfos" using ("userId")
    join "friendPreferences" using ("userId")
    left join "profilePics" using ("userId")
  where "userId" = $1
  `;

  const params = [hateMateUserId];

  db.query(sql, params)
    .then(result => {

      if (result.rows.length === 0) {
        res.status(200).json(result.rows);
      } else {
        const userInfo = result.rows[0];

        const sql = `
        select
          "userSelections".*,
          "selections".*
        from "userSelections"
          join "selections" using ("selectionId")
        where "userId" = $1
        `;

        db.query(sql, params)
          .then(result => {
            if (result.rows.length === 0) {
              res.status(200).json(result.rows);
            } else {
              const userSelections = result.rows;

              const sql = `
              select * from "matchSelections"
              where "userId1" = $1
                and "userId2" = $2
              `;

              let userId1;
              let userId2;

              if (userId < hateMateUserId) {
                userId1 = userId;
                userId2 = hateMateUserId;
              } else {
                userId1 = hateMateUserId;
                userId2 = userId;
              }

              const params = [userId1, userId2];

              db.query(sql, params)
                .then(result => {
                  const matchSelections = result.rows;
                  res.status(201).json({ userInfo, userSelections, matchSelections });
                });
            }
          });
      }
    })
    .catch(err => next(err));

});

app.get('/api/auth/match-map-info', (req, res, next) => {
  const { userId } = req.user;

  const sql = `
  select "lat",
         "lng",
         "mileRadius"
    from "friendPreferences"
    where "userId" = $1
    `;

  const params = [userId];

  db.query(sql, params)
    .then(result => {

      if (result.rows.length === 0) {
        res.status(200).json('no user');
      } else {
        const currentUserLocation = result.rows[0];

        const sql = `
        select "userId1",
                "userId2",
                "matchType"
        from "matches"
        where ("userId1" = $1 OR "userId2" = $1) and ("matchStatus" = 'accepted')
        `;

        db.query(sql, params)
          .then(result => {
            if (result.rows.length === 0) {
              res.status(200).json('no matches');
            } else {
              const matches = result.rows;
              let where = 'where ';
              const params = [];

              matches.forEach(match => {
                if (match.userId1 !== userId) {
                  params.push(match.userId1);
                } else {
                  params.push(match.userId2);
                }
              });
              params.forEach((param, i) => {
                if (i === params.length - 1) {
                  where += `"userId" = $${i + 1}`;
                } else {
                  where += `"userId" = $${i + 1} or `;
                }
              });

              const sql = `
            select
              "users"."userId" as "id",
              "users"."firstName",
              "userInfos"."birthday",
              "userInfos"."gender",
              "friendPreferences"."lat",
              "friendPreferences"."lng",
              "profilePics".*
            from "users"
              join "userInfos" using ("userId")
              join "friendPreferences" using ("userId")
              left join "profilePics" using ("userId")
            ${where}
            `;

              db.query(sql, params)
                .then(result => {
                  const matchList = result.rows;

                  matchList.forEach(match => {
                    matches.forEach(matchType => {
                      if (matchType.userId1 === match.id || matchType.userId2 === match.id) {
                        match.matchType = matchType.matchType;
                      }
                    });

                    match.age = getAge(match.birthday);
                    const centerLatDeg = currentUserLocation.lat;
                    const centerLngDeg = currentUserLocation.lng;
                    const checkLatDeg = match.lat;
                    const checkLngDeg = match.lng;

                    const distance = pointDistance(centerLatDeg, centerLngDeg, checkLatDeg, checkLngDeg);
                    match.distance = distance;
                  });

                  res.status(201).json({ currentUserLocation, matchList });

                });

            }
          });
      }
    })
    .catch(err => next(err));

});

app.post('/api/auth/profile-picture', uploadsMiddleware, (req, res, next) => {
  const { userId } = req.user;

  let fileName;
  let url;
  if (process.env.NODE_ENV === 'development') {
    fileName = req.file.filename;
    url = '/imgs/' + fileName;
  } else {
    url = req.file.location;
    fileName = req.file.originalname;
  }

  const sql = `
  insert into "profilePics" ("userId", "url", "fileName")
  values ($1, $2, $3)
  on conflict on constraint "profilePics_pk"
    do
    update set "url" = $2, "fileName" = $3
  returning *
  `;
  const params = [userId, url, fileName];
  db.query(sql, params)
    .then(result => {
      if (result.rows.length === 0) {
        res.status(202).json('no info exists');
      } else res.status(200).json(result.rows[0]);
    })
    .catch(err => next(err));
});

app.delete('/api/auth/profile-picture', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
  delete from "profilePics"
    where "userId" = $1
  returning *`;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      res.status(204).json(result.rows);
    })
    .catch(err => next(err));
});

app.delete('/api/auth/delete-demo-user', (req, res, next) => {
  const { userId } = req.user;
  const sql = `
 WITH deleted_profilePics AS (
  DELETE FROM "profilePics"
  WHERE "userId" = $1
  RETURNING *
),
deleted_users AS (
  DELETE FROM "users"
  WHERE "userId" = $1
  RETURNING *
),
deleted_userSelections AS (
  DELETE FROM "userSelections"
  WHERE "userId" = $1
  RETURNING *
),
deleted_userInfos AS (
  DELETE FROM "userInfos"
  WHERE "userId" = $1
  RETURNING *
),
deleted_friendPreferences AS (
  DELETE FROM "friendPreferences"
  WHERE "userId" = $1
  RETURNING *
),
deleted_matches AS (
  DELETE FROM "matches"
  WHERE "userId1" = $1 OR "userId2" = $1
  RETURNING *
),
deleted_matchSelections AS (
  DELETE FROM "matchSelections"
  WHERE "userId1" = $1 OR "userId2" = $1
  RETURNING *
)
SELECT
  (SELECT COUNT(*) FROM deleted_profilePics) AS profilePics_deleted,
  (SELECT COUNT(*) FROM deleted_users) AS users_deleted,
  (SELECT COUNT(*) FROM deleted_userSelections) AS userSelections_deleted,
  (SELECT COUNT(*) FROM deleted_userInfos) AS userInfos_deleted,
  (SELECT COUNT(*) FROM deleted_friendPreferences) AS friendPreferences_deleted;
  `;
  const params = [userId];
  db.query(sql, params)
    .then(result => {
      res.status(204).json(result.rows);
    })
    .catch(err => next(err));
});

app.use(errorMiddleware);

app.listen(process.env.PORT, () => {
  process.stdout.write(`\n\napp listening on port ${process.env.PORT}\n\n`);
});
