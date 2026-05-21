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

const verifyToken = async (req, res, next) => {
  console.log("HEADERS: ", req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access!" });
  }
  try {
    const idToken = token.split(" ")[1]
    const decoded = await admin.auth().verifyIdToken(idToken)
    console.log(decoded)
    req.decoded_email = decoded.email
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorized access!" });
  }
  
};
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


    // user related API
    app.post("/users",async(req,res)=>{
      const user = req.body;
      user.role="user"
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({  email });
      if(userExists){
        return res.send({message:"User already exists"})
      }
      const result = await userCollection.insertOne(user);
      res.send(result)
    })




    // parcel API
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    // payment API
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
      const trackingId = generateTrackingId();
      console.log("Session retrive: ", session);

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
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
        if(email !== req.decoded_email){
          return res.status(401).send({ message: "Forbidden access!" });
        }
      }
      const cursor = paymentCollection.find(query).sort({paidAt:-1});
      const result = await cursor.toArray();
      res.send(result);
    });

    // old payment api
    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     // ui_mode: "elements",
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "USD",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],
    //     customer_email: paymentInfo.senderEmail,
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //     },
    //     mode: "payment",
    //     // return_url: `${process.env.SITE_DOMAIN}/complete?session_id={CHECKOUT_SESSION_ID}`,
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //     // cancel_url: `${process.env.SITE_DOMAIN}/complete?session_id={CHECKOUT_SESSION_ID}`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });
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
