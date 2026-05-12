import { Router, type IRouter } from "express";
import healthRouter from "./health";
import locationsRouter from "./locations";
import usersRouter from "./users";

const router: IRouter = Router();

router.use(healthRouter);
router.use(locationsRouter);
router.use(usersRouter);

export default router;
