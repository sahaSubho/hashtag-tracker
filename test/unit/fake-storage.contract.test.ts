import { FakeStorage } from "../helpers/fakes.js";
import { blobStorageContract } from "../contract/blob-storage.contract.js";

blobStorageContract(() => new FakeStorage());
