const express = require("express");
const app = express();
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 8082;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const admin = require("firebase-admin");
const serviceAccount = require("./zapshift-firebase-admin.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Tracking ID
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// middleware
app.use(express.json());
app.use(cors());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.1rbhjut.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    await client.connect();
    const db = client.db("ZapShift_db");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingCollection = db.collection("trackings");

    // Verify Token Function
    const verifyToken = async (req, res, next) => {
      console.log("HEADERS: ", req.headers.authorization);
      const token = req.headers.authorization;
      if (!token) {
        return res.status(401).send({ message: "Unauthorized access!" });
      }
      try {
        const idToken = token.split(" ")[1];
        const decoded = await admin.auth().verifyIdToken(idToken);
        console.log(decoded);
        req.decoded_email = decoded.email;
        next();
      } catch (error) {
        return res.status(401).send({ message: "Unauthorized access!" });
      }
    };
    // Verify Admin before allwoing admin activity
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // ------------------------------------------------
    // Rider Related API
    // ------------------------------------------------
    app.post("/riders", verifyToken, async (req, res) => {
      const rider = req.body;
      rider.createdAt = new Date();
      rider.status = "pending";
      rider.email = req.decoded_email;
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    // Getting Pending Status Riders
    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });
    app.patch("/riders/:id", verifyToken, verifyAdmin, async (req, res) => {
      const status = req.body.status;
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: status,
          workStatus: "available",
        },
      };
      const result = await ridersCollection.updateOne(query, updateDoc);
      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser,
        );
      }
      res.send(result);
    });

    // TRcking parcel
    const logTracking = async (trackingId, status) => {
       console.log("logTracking called:", trackingId, status)
      const log = {
        trackingId,
        status,
        createdAt: new Date(),
        details: status.split(/[-_]/).join(" "),
      };
      const result = await trackingCollection.insertOne(log);
      return result;
    };

    // ------------------------------------------------
    //User Related API
    // ------------------------------------------------
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email });
      if (userExists) {
        return res.send({ message: "User already exists" });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // Getting all users
    app.get("/users", verifyToken, async (req, res) => {
      const searchText = req.query.searchText?.trim();
      const query = {};

      if (searchText) {
        const parts = searchText.split(" ").filter(Boolean);

        if (parts.length >= 2) {
          // Search firstName and lastName
          query.$and = [
            { firstName: { $regex: parts[0], $options: "i" } },
            { lastName: { $regex: parts.slice(1).join(" "), $options: "i" } },
          ];
        } else {
          // search either firstName or lastName
          query.$or = [
            { firstName: { $regex: searchText, $options: "i" } },
            { lastName: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } },
          ];
        }
      }

      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(10);
      const result = await cursor.toArray();
      res.send(result);
    });

    // update role to make admin
    app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const roleInfo = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          role: roleInfo.role,
        },
      };
      const result = await userCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // ------------------------------------------------
    // Parcel API
    // ------------------------------------------------
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const trackingId = generateTrackingId();
      parcel.createdAt = new Date();
      parcel.trackingId = trackingId;
      await logTracking(trackingId, "parcel_created");
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });
    app.patch("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const { parceId, riderId, riderName, riderEmail, trackingId } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelCollection.updateOne(query, updateDoc);

      //  Update Rider Information
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdateDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        riderUpdateDoc,
      );
      // log tracking
      await logTracking(trackingId, "driver_assigned");

      res.send(riderResult);
    });
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });
    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = {$in:["driver_assigned","rider_arriving"]}
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus === deliveryStatus;
      }
      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId,trackingId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };
      if (deliveryStatus === "parcel_delivered") {
        //  Update Rider Information
        const riderQuery = { _id: new ObjectId(riderId) };
        const riderUpdateDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          riderUpdateDoc,
        );
      }
      const result = await parcelCollection.updateOne(query, updateDoc);
      // log tracking
      await logTracking(trackingId,deliveryStatus)
      res.send(result);
    });

    // ------------------------------------------------
    // payment API
    // ------------------------------------------------
    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: `Please Pay for: ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
          trackingId: paymentInfo.trackingId,
        },
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      console.log(session);
      res.send({ url: session.url });
    });

    // Getting URL session from Frontend
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const paymentExist = await paymentCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "Payment already exist",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }
      // const trackingId = generateTrackingId(); old way
      const trackingId = session.metadata.trackingId;
      // console.log("Session retrive: ", session);

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            // trackingId: trackingId,
          },
        };
        const result = await parcelCollection.updateOne(query, updateDoc);
        console.log(result);
        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          await logTracking(trackingId, "parcel-paid");
          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        } else {
          res.send({ success: false });
        }
      }
    });

    app.get("/payments", verifyToken, async (req, res) => {
      const email = req.query.email;
      const query = {};

      if (email) {
        query.customerEmail = email;
        if (email !== req.decoded_email) {
          return res.status(401).send({ message: "Forbidden access!" });
        }
      }
      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Tracking Related API 
    app.get("/trackings/:trackingId/logs", async (req, res) => {
      const trackingId = req.params.trackingId;
      
      const query = { trackingId };
      
      const result = await trackingCollection.find(query).toArray();
      res.send(result);
    })
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);
app.get("/", (req, res) => {
  res.send("Zap Shift Server is Running!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
