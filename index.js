"use strict";

const Airtable = require("airtable");
const snoowrap = require("snoowrap");
const moment = require("moment-timezone");
const request = require("superagent");

function celsius(fahrenheit) {
  return (fahrenheit - 32) * (5 / 9);
}

const THREAD_ID = "zersmomw72dw";

const TABLE_HEADER_SIDEBAR = `Place|Weather|Cloud Cover|Totality Time|
:--|:--|:--|:--|`;

const TABLE_HEADER_POST = `Place|Weather|Temperature|Cloud Cover|Totality Time|
:--|:--|:--|:--|:--|`;

function post(r, data, lastPost) {
  let table = TABLE_HEADER_POST;
  table += data
    .map(
      item =>
        // prettier-ignore
        `${item.name}|${item.general}|${item.temperature.toFixed(0)}°F (${celsius(item.temperature).toFixed(0)}°C)|${(item.cloudCover * 100).toFixed(0)}%|${moment(item.time).tz(item.timezone).format("h:mm a z")}|`
    )
    .join("\n");
  const updated = moment(lastPost).fromNow();
  return r.getLivethread(THREAD_ID).addUpdate(`**Weather Forecast Update**:

${table}

Previous update was ${updated}. Forecast is at time of totality and will get more accurate the closer we get to totality.

*Brought to you by your VLT bot, bleep bloop. Data from [Dark Sky](https://darksky.net/poweredby/).*
`);
}

function sidebar(r, data, lastPost) {
  return r.getLivethread(THREAD_ID).fetch().then(thread => {
    const oldResources = thread.resources;
    let table = TABLE_HEADER_SIDEBAR;
    table += data
      .map(
        item =>
          // prettier-ignore
          `${item.name}|${item.general}|${(item.cloudCover * 100).toFixed(0)}%|${moment(item.time).tz(item.timezone).format("h:mm a z")}|`
      )
      .join("\n");
    const updated =
      moment().tz("America/Los_Angeles").format("MMMM DD YYYY, h:mm a z") +
      " (" +
      moment().tz("UTC").format("h:mm a z") +
      ")";
    const attrib = "Data from [Dark Sky](https://darksky.net/poweredby/).";
    const newResources = oldResources.replace(
      /(#Weather Forecast\n\n)([\s\S]+)(\n\n\*Last updated )(.+)(\*\n)/m,
      "$1" + table + "$3" + updated + ". " + attrib + "$5"
    );
    return thread.editSettings({
      title: thread.title,
      description: thread.description,
      resources: newResources
    });
  });
}

module.exports = (ctx, cb) => {
  const r = new snoowrap({
    userAgent: ctx.secrets.REDDIT_USER_AGENT,
    clientId: ctx.secrets.REDDIT_ID,
    clientSecret: ctx.secrets.REDDIT_SECRET,
    username: ctx.secrets.REDDIT_USERNAME,
    password: ctx.secrets.REDDIT_PASSWORD
  });
  const base = new Airtable({ apiKey: ctx.secrets.AIRTABLE_KEY }).base(
    "appfGZABnNVfKyrF2"
  );

  ctx.storage.get((error, storageData) => {
    if (error) {
      cb(error);
      return;
    }

    storageData = storageData || {
      lastPostTime: "2017-08-13T00:00:00Z",
      lastSidebarTime: "2017-08-13T00:00:00Z"
    };

    // Check posting rules
    base("Posting Rules")
      .select({
        maxRecords: 1,
        filterByFormula: "IS_BEFORE({Start}, NOW())",
        sort: [{ field: "Start", direction: "desc" }]
      })
      .firstPage((err, page) => {
        const rule = page.map(item => ({
          start: item.get("Start"),
          post: item.get("Post Rule"),
          sidebar: item.get("Sidebar Rule")
        }))[0];

        function never() {
          return () => false;
        }

        function hourInterval(hours) {
          // last post PLUS interval > now
          return type => {
            if (type === "post") {
              return moment(storageData.lastPostTime)
                .add(hours, "h")
                .isSameOrBefore(moment());
            } else if (type === "sidebar") {
              return moment(storageData.lastSidebarTime)
                .add(hours, "h")
                .isSameOrBefore(moment());
            }
          };
        }

        const doPost = eval(rule.post)("post");
        const doSidebar = eval(rule.sidebar)("sidebar");

        if (!(doPost || doSidebar)) {
          // Nothing to do
          cb(
            null,
            "Nothing to do. Last post " +
              storageData.lastPostTime +
              ", last sidebar " +
              storageData.lastSidebarTime
          );
        } else {
          // Load in location data
          base("Locations")
            .select({
              maxRecords: 100,
              pageSize: 100,
              sort: [{ field: "ID", direction: "asc" }]
            })
            .firstPage((err, page) => {
              Promise.all(
                page
                  .map(item => ({
                    name: item.get("Location"),
                    timezone: item.get("Time Zone"),
                    geo: item.get("Geo"),
                    time: item.get("Time of Totality")
                  }))
                  .map(item => {
                    // Load weather data
                    // prettier-ignore
                    const url = `https://api.darksky.net/forecast/${ctx.secrets.DARKSKY_KEY}/${item.geo},${moment(item.time).format("YYYY-MM-DDTHH:mm:ss") + "Z"}?exclude=daily,hourly`;
                    console.log(url);
                    return request.get(url).then(data => {
                      const weather = data.body;
                      return Object.assign(item, {
                        general: weather.currently.summary,
                        temperature: weather.currently.temperature,
                        cloudCover: weather.currently.cloudCover
                      });
                    });
                  })
              ).then(data => {
                // Check if we need to post
                (doPost
                  ? post(r, data, storageData.lastPostTime)
                  : Promise.resolve()).then(() => {
                  // Check if we need to sidebar
                  (doSidebar
                    ? sidebar(r, data, storageData.lastSidebarTime)
                    : Promise.resolve()).then(
                    () => {
                      ctx.storage.set(
                        Object.assign(
                          storageData,
                          // prettier-ignore
                          doPost ? { lastPostTime: new Date().toJSON() } : {},
                          // prettier-ignore
                          doSidebar ? { lastSidebarTime: new Date().toJSON() } : {}
                        ),
                        err => {
                          if (err) {
                            return cb(err);
                          } else {
                            cb(null, "ok (" + doPost + ", " + doSidebar + ")");
                            return;
                          }
                        }
                      );
                    },
                    err => {
                      cb(err);
                    }
                  );
                });
              });
            });
        }
      });
  });
};
