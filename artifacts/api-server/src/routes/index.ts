import { Router, type IRouter } from "express";
import healthRouter from "./health";
import locationsRouter from "./locations";
import usersRouter from "./users";
import categoriesRouter from "./categories";
import adminRouter from "./admin";
import ordersRouter from "./orders";
import messagesRouter from "./messages";
import driversOnlineRouter from "./drivers-online";
import settingsRouter from "./settings";
import storageRouter from "./storage";
import ratingsRouter from "./ratings";
import gasOrdersRouter from "./gas-orders";
import gameRouter from "./game";

const router: IRouter = Router();

router.use(adminRouter);
router.use(healthRouter);
router.use(locationsRouter);
router.use(usersRouter);
router.use(categoriesRouter);
router.use(ordersRouter);
router.use(messagesRouter);
router.use(driversOnlineRouter);
router.use(settingsRouter);
router.use(storageRouter);
router.use(ratingsRouter);
router.use(gasOrdersRouter);
router.use(gameRouter);

export default router;
