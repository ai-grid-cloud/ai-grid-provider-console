import type { CreateModelRequest, ManagedModel, ModelUpdate } from './types';

/** The Models area: model deployments and the locations they are placed on. */
export interface ModelsService {
  listModels(): Promise<ManagedModel[]>;
  /** One model deployment; fails with a 404 when there is none. */
  getModel(namespace: string, name: string): Promise<ManagedModel>;
  /** Locations of Ready, provisioned AI Grid members. */
  listLocations(): Promise<string[]>;
  /** Creates the model in the console's models namespace (ConsoleConfig.modelsNamespace). */
  createModel(input: CreateModelRequest): Promise<ManagedModel>;
  /** Changes a deployed model; fails with a conflict when `resourceVersion` is not the current one. */
  updateModel(namespace: string, name: string, update: ModelUpdate, resourceVersion: string): Promise<ManagedModel>;
  /** Fails with a conflict when `resourceVersion` is not the current one. */
  deleteModel(namespace: string, name: string, resourceVersion: string): Promise<void>;
}
