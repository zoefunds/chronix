import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

export const errorHandlerPlugin = fp(async (fastify: FastifyInstance) => {
  fastify.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: "validation_error",
        message: "Request failed validation",
        details: error.flatten(),
      });
      return;
    }

    if (error.validation) {
      reply.code(400).send({
        error: "validation_error",
        message: error.message,
      });
      return;
    }

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Unhandled error");
    } else {
      request.log.warn({ err: error }, "Request error");
    }

    reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : "request_error",
      message: statusCode >= 500 ? "An internal error occurred" : error.message,
    });
  });

  fastify.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "not_found", message: `Route ${request.method} ${request.url} not found` });
  });
});
