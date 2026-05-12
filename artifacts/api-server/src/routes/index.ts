import { Router, type IRouter } from "express";
import healthRouter from "./health";
import locationsRouter from "./locations";
import usersRouter from "./users";
import categoriesRouter from "./categories";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(adminRouter);
router.use(healthRouter);
router.use(locationsRouter);
router.use(usersRouter);
router.use(categoriesRouter);

export default router;
