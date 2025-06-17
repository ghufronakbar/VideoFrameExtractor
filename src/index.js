import { configDotenv } from 'dotenv';
configDotenv()
import express from 'express';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import cors from 'cors';
import { APP_NAME, PORT, SERVER_URL } from './constant/index.js';
import module from './module.js';
import path from "path";

const app = express();

//PARSE APPLICATION JSON
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(morgan('dev'));
app.use(cors());


app.get('/', (req, res) => {
  return res.status(200).json({ status: 200, message: `Hello World ${APP_NAME}` });
})

app.use('/api/uploads', express.static(path.join(process.cwd(), 'uploads')));
// ROUTES
app.use('/', module);


app.listen(PORT, () => {
  console.log(APP_NAME)
  console.log(`⚡️[server]: Server started on port ${PORT} ⚡`);
  console.log(SERVER_URL);
});