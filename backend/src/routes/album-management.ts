/**
 * Album Management Routes
 * Authenticated routes for creating, deleting albums and managing photos.
 *
 * This file is an aggregator: the handlers were split into cohesive sub-routers
 * (ticket #1506). All sub-routers are mounted on the same base router so the
 * public URLs under /api/albums are unchanged. CSRF protection is applied once
 * here and therefore covers every mounted sub-router.
 */
import { Router } from "express";
import { csrfProtection } from "../security.js";
import crudRouter from "./album-management-crud.js";
import photosRouter from "./album-management-photos.js";
import optimizationRouter from "./album-management-optimization.js";
import organizationRouter from "./album-management-organization.js";
import videoRouter from "./album-management-video.js";

const router = Router();

// Apply CSRF protection to all routes in this router (and its sub-routers)
router.use(csrfProtection);

router.use(crudRouter);
router.use(photosRouter);
router.use(optimizationRouter);
router.use(organizationRouter);
router.use(videoRouter);

export default router;
