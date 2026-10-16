import type { CreateModelRequest, ManagedModel } from './types';

/** The Models area: model deployments and the locations they are placed on. */
export interface ModelsService {
  listModels(): Promise<ManagedModel[]>;
  /** Locations of Ready, provisioned AI Grid members. */
  listLocations(): Promise<string[]>;
  /** Creates the model in the console's models namespace (ConsoleConfig.modelsNamespace). */
  createModel(input: CreateModelRequest): Promise<ManagedModel>;
  /** Fails with a conflict when `resourceVersion` is not the current one. */
  deleteModel(namespace: string, name: string, resourceVersion: string): Promise<void>;
}
