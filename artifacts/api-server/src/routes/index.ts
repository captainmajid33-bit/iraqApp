import { Router, type IRouter } from "express";
import healthRouter from "./health";
import clinicsRouter from "./clinics";

const router: IRouter = Router();

router.use(healthRouter);
router.use(clinicsRouter);

export default router;
