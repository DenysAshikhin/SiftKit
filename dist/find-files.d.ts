export type FindFilesResult = {
    Name: string;
    RelativePath: string;
    FullPath: string;
};
export declare function findFiles(names: string[], searchPath?: string): FindFilesResult[];
